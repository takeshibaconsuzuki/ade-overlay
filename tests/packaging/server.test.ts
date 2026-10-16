import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { extract } from 'tar'
import { stringify } from 'yaml'
import { version } from '../../package.json'

test(
  'the extracted server and its installed chat hook run without Node on PATH',
  { timeout: 300_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'ade portable server '))
    let runningServer: ChildProcess | undefined = undefined
    t.after(async () => {
      if (
        runningServer &&
        runningServer.exitCode === null &&
        runningServer.signalCode === null
      ) {
        runningServer.kill()
        await once(runningServer, 'close')
      }
      await rm(directory, { recursive: true, force: true })
    })
    const platform =
      process.platform === 'win32'
        ? 'win'
        : process.platform === 'darwin'
          ? 'macos'
          : 'linux'
    const name = `ade-server-${version}-${platform}-${process.arch}`
    await extract({
      file: resolve('out/packages', `${name}.tar.gz`),
      cwd: directory,
    })
    const contents = join(directory, name)
    const executable = join(
      contents,
      process.platform === 'win32' ? 'ade-server.exe' : 'ade-server',
    )
    await readFile(join(contents, 'server.config.example.yaml'), 'utf8')
    const codexHome = join(directory, 'codex')
    const claudeHome = join(directory, 'claude')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      LOG_LEVEL: 'info',
    }
    // Strip inherited module loaders and all executable search paths.
    for (const key of Object.keys(env))
      if (['path', 'node_path', 'node_options'].includes(key.toLowerCase()))
        delete env[key]
    env.PATH = ''
    const launch = (file: string, args: string[], input = '') => {
      const child = spawn(file, args, {
        cwd: contents,
        env,
        windowsHide: true,
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.stdin.end(input)
      return once(child, 'close').then(([code]) => ({ code, stdout, stderr }))
    }
    const help = await launch(executable, ['--help'])
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout, /--config/)
    const missing = await launch(executable, ['--config', 'missing.yaml'])
    assert.equal(missing.code, 1)
    assert.match(missing.stdout, /Failed to load server configuration/)

    await writeFile(
      join(contents, 'server.config.yaml'),
      stringify({
        host: '127.0.0.1',
        port: 0,
        vscode: { settingsFile: join(directory, 'settings.json') },
      }),
    )
    const server = spawn(executable, [], {
      cwd: contents,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    runningServer = server
    let output = ''
    server.stderr.on('data', (chunk) => {
      output += chunk
    })
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`Server startup timed out: ${output}`)),
        240_000,
      )
      server.once('error', reject)
      server.once('exit', (code) =>
        reject(new Error(`Server exited (${code}): ${output}`)),
      )
      server.stdout.on('data', (chunk) => {
        output += chunk
        if (output.includes('"msg":"Chat hooks installed"')) {
          clearTimeout(deadline)
          resolve()
        }
      })
      server.once('close', () => clearTimeout(deadline))
    })
    const hooks = JSON.parse(
      await readFile(join(codexHome, 'hooks.json'), 'utf8'),
    )
    const hook = hooks.hooks.UserPromptSubmit[0].hooks[0]
    const command =
      process.platform === 'win32' ? hook.commandWindows : hook.command
    assert.match(command, /--report-chat/)
    const reporter =
      process.platform === 'win32'
        ? await launch(
            join(
              process.env.SystemRoot!,
              'System32/WindowsPowerShell/v1.0/powershell.exe',
            ),
            ['-NoProfile', '-NonInteractive', '-Command', command],
            'invalid JSON',
          )
        : await launch('/bin/sh', ['-c', command], 'invalid JSON')
    assert.equal(reporter.code, 0, reporter.stderr)
    assert.equal(reporter.stdout, '')
    assert.equal(reporter.stderr, '')
    const claudeHook = JSON.parse(
      await readFile(join(claudeHome, 'settings.json'), 'utf8'),
    ).hooks.UserPromptSubmit[0].hooks[0]
    assert.equal(claudeHook.args[0], '--report-chat')
    // Claude Code spawns exec-form hooks directly, without a shell.
    const claudeReporter = await launch(
      claudeHook.command,
      claudeHook.args,
      'invalid JSON',
    )
    assert.equal(claudeReporter.code, 0, claudeReporter.stderr)
    assert.equal(claudeReporter.stdout, '')
    assert.equal(claudeReporter.stderr, '')
  },
)
