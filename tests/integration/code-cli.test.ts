import assert from 'node:assert/strict'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  codeEnvironment,
  findLocalCode,
} from '../../src/server/editors/code-cli.ts'
import { EditorRuntimeManager } from '../../src/server/editors/vscode-runtime.ts'
import { vscodeRelease } from '../../src/server/editors/vscode-release.ts'
import { silentLogger } from '../../src/server/logging.ts'
import { ExecaError } from 'execa'

test('editor child environments remove credentials and profile overrides without changing the parent', (t) => {
  const original = process.env
  t.after(() => {
    process.env = original
  })
  process.env = {
    ...original,
    ADE_COMPANION_TOKEN: 'test-companion-secret',
    ade_companion_token: 'test-lowercase-secret',
    ADE_CHAT_EXTENSION_TOKEN: 'extension-secret',
    ade_chat_extension_token: 'lowercase-extension-secret',
    VSCODE_IPC_HOOK_CLI: 'parent-window',
    VSCODE_DEV: '1',
    VSCODE_PORTABLE: 'portable-profile',
    vscode_portable: 'lowercase-portable-profile',
    VSCODE_APPDATA: 'appdata-profile',
    vscode_appdata: 'lowercase-appdata-profile',
    VSCODE_EXTENSIONS: 'extensions-profile',
    vscode_extensions: 'lowercase-extensions-profile',
    ELECTRON_RUN_AS_NODE: '1',
    WATCH_REPORT_DEPENDENCIES: '1',
    watch_report_dependencies: '1',
    ADE_ENV_TEST: 'keep-this',
  }
  const child = codeEnvironment()
  assert.equal(child.ADE_ENV_TEST, 'keep-this')
  for (const name of [
    'ADE_COMPANION_TOKEN',
    'ade_companion_token',
    'ADE_CHAT_EXTENSION_TOKEN',
    'ade_chat_extension_token',
    'VSCODE_IPC_HOOK_CLI',
    'VSCODE_DEV',
    'VSCODE_PORTABLE',
    'vscode_portable',
    'VSCODE_APPDATA',
    'vscode_appdata',
    'VSCODE_EXTENSIONS',
    'vscode_extensions',
    'ELECTRON_RUN_AS_NODE',
    'WATCH_REPORT_DEPENDENCIES',
    'watch_report_dependencies',
  ])
    assert.equal(child[name], undefined)
  assert.equal(process.env.ADE_COMPANION_TOKEN, 'test-companion-secret')
  assert.equal(process.env.VSCODE_PORTABLE, 'portable-profile')
  assert.equal(process.env.VSCODE_APPDATA, 'appdata-profile')
  assert.equal(process.env.WATCH_REPORT_DEPENDENCIES, '1')
})

test(
  'stable CLI prepares only the approved runtime, reuses immutable copies and cancels preparation',
  { timeout: 60_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ade-code-cli-')))
    const bin = join(root, 'installed Code', 'bin')
    const data = join(root, 'editor data')
    const portable = join(root, 'portable data')
    const stateFile = join(root, 'release.json')
    const metadata = join(root, 'bootstrap.json')
    const env = { ...process.env }
    const managers: EditorRuntimeManager[] = []
    t.after(async () => {
      for (const manager of managers) await manager.close()
      process.env = env
      assert.ok(
        resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep),
      )
      assert.ok(root.split(sep).at(-1)?.startsWith('ade-code-cli-'))
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    })
    await mkdir(bin, { recursive: true })
    await mkdir(join(portable, 'user-data'), { recursive: true })
    const command = join(
      bin,
      process.platform === 'win32' ? 'code.cmd' : 'code',
    )
    const script = join(bin, 'cli.cjs')
    await writeFile(
      command,
      process.platform === 'win32'
        ? `@"${process.execPath}" "%~dp0cli.cjs" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`,
    )
    await chmod(command, 0o755)
    const supported =
      '--reconnection-grace-time --extensions-dir --user-data-dir --server-data-dir --connection-token-file --server-base-path'
    const require = createRequire(import.meta.url)
    const terminalPackages = ['@xterm/headless', '@xterm/addon-serialize'].map(
      (name) => [name, dirname(require.resolve(`${name}/package.json`))],
    )
    await writeFile(
      script,
      `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    if (process.env.VSCODE_IPC_HOOK_CLI) process.exit(8);
    if (process.env.ADE_COMPANION_TOKEN) process.exit(9);
    if (process.env.VSCODE_PORTABLE || process.env.VSCODE_APPDATA) process.exit(10);
    if (args[0] === '--version') { console.log('1.99.0\\n${'a'.repeat(40)}\\nx64'); process.exit(0); }
    if (args.includes('--help')) { console.log('--cli-data-dir --connection-token-file --commit-id'); process.exit(0); }
    const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}));
    const value = key => args[args.indexOf(key) + 1];
    if (state.fail) { console.error('offline'); process.exit(1); }
    else {
      const runtime = path.join(value('--cli-data-dir'), 'serve-web', value('--commit-id'));
      fs.mkdirSync(path.join(runtime, 'out'), {recursive:true});
      for (const [name, source] of ${JSON.stringify(terminalPackages)})
        fs.cpSync(source, path.join(runtime, 'node_modules', name), {recursive:true});
      const node = path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
      if (!fs.existsSync(node)) fs.copyFileSync(process.execPath, node);
      fs.writeFileSync(path.join(runtime, 'product.json'), JSON.stringify({commit: state.commit}));
      fs.writeFileSync(path.join(runtime, 'out', 'server-main.js'), 'if (process.env.ADE_COMPANION_TOKEN) process.exit(9); if (process.env.VSCODE_PORTABLE || process.env.VSCODE_APPDATA) process.exit(10); console.log(' + JSON.stringify(state.invalid ? '--help' : ${JSON.stringify(supported)}) + ')');
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({args, pid:process.pid, childPid:child.pid}));
      const token = fs.readFileSync(value('--connection-token-file'), 'utf8');
      let requests = 0;
      const server = require('node:http').createServer((req, res) => {
        if (req.headers.cookie !== 'vscode-tkn=' + token) { res.writeHead(403); res.end(); return; }
        res.writeHead(state.delay || !requests++ ? 202 : 200); res.end('ready');
      });
      server.listen(0, '127.0.0.1', () => {
        console.log('Web UI available at http://127.0.0.1:' + server.address().port + '?tkn=' + token);
      });
    }
  `,
    )
    process.env.PATH = [
      bin,
      process.platform === 'win32'
        ? join(process.env.SystemRoot!, 'System32')
        : '/usr/bin',
      '/bin',
    ].join(delimiter)
    process.env.VSCODE_PORTABLE = portable
    process.env.VSCODE_APPDATA = join(root, 'custom appdata')
    process.env.VSCODE_IPC_HOOK_CLI = 'parent-window'
    process.env.ADE_COMPANION_TOKEN = 'test-companion-secret'
    process.env.VSCODE_EXTENSIONS = join(root, 'custom extensions')
    const code = await findLocalCode(silentLogger)
    assert.ok(code)
    const appData =
      process.platform === 'win32'
        ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : process.platform === 'darwin'
          ? join(homedir(), 'Library', 'Application Support')
          : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
    assert.equal(code.userDataDir, join(appData, 'Code'))
    assert.equal(code.extensionsDir, join(homedir(), '.vscode', 'extensions'))
    assert.equal(process.env.VSCODE_APPDATA, join(root, 'custom appdata'))
    const manager = new EditorRuntimeManager(data)
    managers.push(manager)
    const release = async (state: Record<string, unknown>) =>
      writeFile(stateFile, JSON.stringify(state))
    const stopped = async () => {
      const { args, pid, childPid } = JSON.parse(
        await readFile(metadata, 'utf8'),
      )
      assert.equal(args[args.indexOf('--commit-id') + 1], vscodeRelease.commit)
      assert.ok(!args.includes('--connection-token'))
      for (const id of [pid, childPid])
        assert.throws(() => process.kill(id, 0), { code: 'ESRCH' })
      assert.ok(
        !(await readdir(data)).some((name) =>
          name.startsWith('.code-bootstrap-'),
        ),
      )
    }
    await release({ commit: vscodeRelease.commit })
    manager.prepareRuntime()
    const [first, duplicate] = await Promise.all([manager.get(), manager.get()])
    assert.deepEqual(first, duplicate)
    assert.ok(first.entrypoint.includes(`stable-${vscodeRelease.commit}`))
    await stopped()
    // CLI cache eviction must not affect a runtime handed to editor sessions.
    const cache = resolve(data, 'cli')
    assert.ok(cache.startsWith(resolve(data) + sep))
    await rm(cache, { recursive: true, force: true })
    await readFile(first.entrypoint)
    await release({ fail: true })
    const restarted = new EditorRuntimeManager(data)
    managers.push(restarted)
    assert.deepEqual(await restarted.get(), first)
    assert.deepEqual(await manager.get(), first)
    const freshData = join(root, 'empty data')
    const fresh = new EditorRuntimeManager(freshData)
    managers.push(fresh)
    await assert.rejects(fresh.get(), /runtime preparation stopped/)
    await release({ commit: vscodeRelease.commit, invalid: true })
    await assert.rejects(fresh.get(), /does not support/)
    assert.deepEqual(
      await readdir(join(freshData, 'runtimes')),
      [],
      'an invalid candidate must not be published or leave staging behind',
    )
    await stopped()
    await release({ commit: 'c'.repeat(40) })
    await assert.rejects(fresh.get(), /does not match the prepared release/)
    await release({ commit: vscodeRelease.commit })
    assert.ok((await fresh.get()).entrypoint.includes(vscodeRelease.commit))
    // Cancel a pending bootstrap and verify both wrapper and backend have exited.
    await release({ commit: vscodeRelease.commit, delay: true })
    const cancelled = new EditorRuntimeManager(join(root, 'cancel data'))
    managers.push(cancelled)
    const pending = assert.rejects(cancelled.get(), /shutting down/)
    while (
      !JSON.parse(await readFile(metadata, 'utf8')).args.includes(
        join(root, 'cancel data', 'cli', 'stable'),
      )
    )
      await delay(50)
    await cancelled.close()
    await pending
    await stopped()
    await rename(
      command,
      join(
        bin,
        process.platform === 'win32' ? 'code-insiders.cmd' : 'code-insiders',
      ),
    )
    await assert.rejects(findLocalCode(silentLogger), /Install stable VS Code/)
    process.env.PATH = join(root, 'empty')
    const missing = new EditorRuntimeManager(join(root, 'missing data'))
    managers.push(missing)
    await assert.rejects(missing.get(), /Install stable VS Code/)
  },
)

test(
  'CLI discovery owns bounded, cancellable command execution',
  { timeout: 30_000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'ade-cli-commands-')),
    )
    const bin = join(root, 'Code bin')
    const config = join(root, 'scenario.json')
    const record = join(root, 'processes.json')
    const environment = process.env
    let pids: number[] = []
    t.after(async () => {
      process.env = environment
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* Already stopped. */
        }
      }
      assert.ok(
        resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep),
      )
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    })
    await mkdir(bin)
    const script = join(bin, 'cli.mjs')
    await copyFile(
      new URL('../fixtures/discovery-cli.mjs', import.meta.url),
      script,
    )
    const command = join(
      bin,
      process.platform === 'win32' ? 'code.cmd' : 'code',
    )
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(
      command,
      process.platform === 'win32'
        ? `@"${process.execPath}" "%~dp0cli.mjs" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
      { mode: 0o755 },
    )
    const childEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      ADE_TEST_CLI_CONFIG: config,
      ADE_COMPANION_TOKEN: 'fixture-private-token',
      VSCODE_IPC_HOOK_CLI: 'fixture-parent-window',
    }
    for (const name of Object.keys(childEnvironment))
      if (name.toUpperCase() === 'PATH') delete childEnvironment[name]
    childEnvironment.PATH = [
      bin,
      process.platform === 'win32'
        ? join(environment.SystemRoot!, 'System32')
        : '/usr/bin',
      '/bin',
    ].join(delimiter)
    process.env = childEnvironment
    const scenario = (mode: string) =>
      writeFile(config, JSON.stringify({ mode, record }))
    const running = async () => {
      while (true) {
        t.signal.throwIfAborted()
        try {
          pids = JSON.parse(await readFile(record, 'utf8'))
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await delay(20, undefined, { signal: t.signal })
        }
      }
    }
    const stopped = async () => {
      for (const pid of pids) {
        while (true) {
          t.signal.throwIfAborted()
          try {
            process.kill(pid, 0)
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
            break
          }
          await delay(20, undefined, { signal: t.signal })
        }
      }
      pids = []
      await rm(record)
    }
    await t.test(
      'sanitizes the actual child environment and supports CLI paths with spaces',
      async () => {
        await scenario('success')
        assert.equal((await findLocalCode(silentLogger)).commit, 'a'.repeat(40))
      },
    )
    await t.test('retains failure diagnostics', async () => {
      await scenario('failure')
      await assert.rejects(
        findLocalCode(silentLogger),
        (error) =>
          error instanceof ExecaError &&
          error.exitCode === 7 &&
          error.stderr === 'fixture CLI diagnosis',
      )
    })
    await t.test('rejects oversized output', async () => {
      await scenario('oversized')
      await assert.rejects(
        findLocalCode(silentLogger),
        (error) => error instanceof ExecaError && error.isMaxBuffer,
      )
    })
    await t.test(
      'cancellation terminates the CLI and its descendants',
      async () => {
        await scenario('waiting')
        const abort = new AbortController()
        const rejected = assert.rejects(
          findLocalCode(silentLogger, abort.signal),
          (error) => error instanceof ExecaError && error.isCanceled,
        )
        await Promise.race([running(), rejected])
        abort.abort()
        await rejected
        await stopped()
      },
    )
    await t.test(
      'discovery timeout terminates the CLI and its descendants',
      async () => {
        await scenario('waiting')
        const rejected = assert.rejects(
          findLocalCode(silentLogger),
          (error) => error instanceof ExecaError && error.timedOut,
        )
        await Promise.race([running(), rejected])
        await rejected
        await stopped()
      },
    )
  },
)
