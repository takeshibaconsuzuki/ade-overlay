import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { codeEnvironment, findLocalCode } from '../src/server/code-cli.ts'
import { EditorRuntimeManager } from '../src/server/vscode-runtime.ts'
import { silentLogger } from '../src/server/logging.ts'

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
  'installed CLI prepares latest updates, validates them, retains live runtimes and falls back offline',
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
    if (args.includes('--help')) { console.log('--cli-data-dir --connection-token-file'); process.exit(0); }
    const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}));
    const value = key => args[args.indexOf(key) + 1];
    if (state.fail) { console.error('error getting latest version: offline'); setInterval(() => {}, 1000); }
    else {
      const runtime = path.join(value('--cli-data-dir'), 'serve-web', state.commit);
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
      let checked = false;
      let requests = 0;
      const server = require('node:http').createServer((req, res) => {
        if (!checked) { res.writeHead(500); res.end('update check was skipped'); return; }
        if (req.headers.cookie !== 'vscode-tkn=' + token) { res.writeHead(403); res.end(); return; }
        res.writeHead(requests++ ? 200 : 202); res.end('ready');
      });
      server.listen(0, '127.0.0.1', () => {
        console.log('Web UI available at http://127.0.0.1:' + server.address().port + '?tkn=' + token);
        setTimeout(() => { checked=true; console.log('refreshed latest release: Stable-' + state.commit); }, state.delay || 200);
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
    delete process.env.VSCODE_EXTENSIONS
    const code = await findLocalCode(silentLogger)
    assert.ok(code)
    assert.equal(code.userDataDir, join(portable, 'user-data'))
    assert.equal(code.extensionsDir, join(portable, 'extensions'))
    delete process.env.VSCODE_PORTABLE
    const appDataCode = await findLocalCode(silentLogger)
    assert.equal(appDataCode?.userDataDir, join(root, 'custom appdata', 'Code'))
    assert.equal(process.env.VSCODE_APPDATA, join(root, 'custom appdata'))
    process.env.VSCODE_PORTABLE = portable
    const manager = new EditorRuntimeManager(data)
    managers.push(manager)
    t.mock.timers.enable({ apis: ['setInterval'] })
    const release = async (state: Record<string, unknown>) =>
      writeFile(stateFile, JSON.stringify(state))
    const stopped = async () => {
      const { args, pid, childPid } = JSON.parse(
        await readFile(metadata, 'utf8'),
      )
      assert.ok(!args.includes('--commit-id'))
      assert.ok(!args.includes('--connection-token'))
      for (const id of [pid, childPid])
        assert.throws(() => process.kill(id, 0), { code: 'ESRCH' })
      assert.ok(
        !(await readdir(data)).some((name) =>
          name.startsWith('.code-bootstrap-'),
        ),
      )
    }
    await release({ commit: 'b'.repeat(40) })
    manager.startUpdates()
    const [first, duplicate] = await Promise.all([
      manager.checkForUpdates(),
      manager.checkForUpdates(),
    ])
    assert.deepEqual(first, duplicate)
    assert.match(first.entrypoint, /stable-b{40}/)
    await stopped()
    await release({ commit: 'c'.repeat(40), invalid: true })
    const periodic = new Promise<void>((resolve) =>
      manager.once('progress', () => resolve()),
    )
    t.mock.timers.tick(60 * 60 * 1000)
    await periodic
    assert.deepEqual(await manager.checkForUpdates(), first)
    await stopped()
    await release({ commit: 'c'.repeat(40) })
    const next = await manager.checkForUpdates()
    assert.match(next.entrypoint, /stable-c{40}/)
    assert.deepEqual(await manager.get(), next)
    await stopped()
    // CLI cache eviction must not affect either runtime handed to editor sessions.
    const cache = resolve(data, 'cli')
    assert.ok(cache.startsWith(resolve(data) + sep))
    await rm(cache, { recursive: true, force: true })
    await readFile(first.entrypoint)
    await readFile(next.entrypoint)
    await release({ fail: true })
    assert.deepEqual(await manager.checkForUpdates(), next)
    const restarted = new EditorRuntimeManager(data)
    managers.push(restarted)
    assert.deepEqual(await restarted.get(), next)
    const fresh = new EditorRuntimeManager(join(root, 'empty data'))
    managers.push(fresh)
    await assert.rejects(fresh.get(), /could not check for updates/)
    // Cancel a pending bootstrap and verify both wrapper and backend have exited.
    await release({ commit: 'd'.repeat(40), delay: 30_000 })
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
    process.env.PATH = join(root, 'empty')
    const missing = new EditorRuntimeManager(data)
    managers.push(missing)
    await assert.rejects(missing.get(), /VS Code is required/)
  },
)
