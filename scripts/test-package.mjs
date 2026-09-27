import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  chmod,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile, listPackage } from '@electron/asar'
import spawn from 'cross-spawn'
import { WebSocket } from 'ws'

const root = fileURLToPath(new URL('../', import.meta.url))
const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const platform = process.platform
const archive = join(
  root,
  'dist',
  `ade-companion-${app.version}-${platform}-${process.arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`,
)
const temporary = await mkdtemp(join(tmpdir(), 'ade package '))
let server
let socket

function run(command, args, options = {}) {
  const result = spawn.sync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

try {
  run('tar', ['-xf', archive, '-C', temporary])
  const companion = join(temporary, 'ade-companion')
  const home = join(temporary, 'home')
  await mkdir(home)
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    XDG_CONFIG_HOME: home,
    CODEX_HOME: join(home, 'codex'),
    VSCODE_EXTENSIONS: join(home, 'extensions'),
    ADE_COMPANION_HOST: '127.0.0.1',
    ADE_COMPANION_TOKEN: '',
  }
  // A release must work without Node/npm or the repository on the user's PATH.
  for (const key of Object.keys(env))
    if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH =
    platform === 'win32'
      ? join(process.env.SystemRoot, 'System32')
      : '/usr/bin:/bin'
  const launcher = join(
    companion,
    platform === 'win32' ? 'ade-companion.cmd' : 'ade-companion',
  )
  const options = { cwd: home, env }
  assert.equal(run(launcher, ['--version'], options).trim(), app.version)
  assert.match(run(launcher, ['--help'], options), /--install-extension/)
  const node = join(
    companion,
    'runtime',
    platform === 'win32' ? 'node.exe' : 'node',
  )
  assert.equal(
    run(node, ['--version'], options).trim(),
    'v' + (await readFile(join(root, '.node-version'), 'utf8')).trim(),
  )
  await readFile(join(companion, 'runtime', 'LICENSE'))

  const config = join(home, 'server config.yaml')
  await writeFile(config, 'projects: []\n')
  // Exercise extension setup with a local CLI fixture, including paths with spaces.
  const bin = join(home, 'Code bin')
  await mkdir(bin)
  const fakeCode = join(bin, 'cli.cjs')
  const record = join(home, 'installed.json')
  await writeFile(
    fakeCode,
    `const fs = require('node:fs'); const args = process.argv.slice(2); if (args.includes('--version')) console.log('1.138.0\\n${'a'.repeat(40)}\\nx64'); else if (args.includes('--help')) console.log('--cli-data-dir --connection-token-file'); else { fs.accessSync(args[args.indexOf('--install-extension') + 1]); fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(args)); }`,
  )
  const command = join(bin, platform === 'win32' ? 'code.cmd' : 'code')
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(
    command,
    platform === 'win32'
      ? `@"${node}" "${fakeCode}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(node)} ${quote(fakeCode)} "$@"\n`,
  )
  await chmod(command, 0o755)
  run(launcher, ['--install-extension', '--config', config], {
    ...options,
    env: { ...env, PATH: bin + (platform === 'win32' ? ';' : ':') + env.PATH },
  })
  const installed = JSON.parse(await readFile(record, 'utf8'))
  const installIndex = installed.indexOf('--install-extension')
  assert.notEqual(installIndex, -1)
  // Node resolves module paths through symlinks (including macOS /var).
  assert.equal(
    await realpath(installed[installIndex + 1]),
    await realpath(join(companion, 'ade-terminals.vsix')),
  )
  assert.ok(installed.includes(env.VSCODE_EXTENSIONS))

  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  server = spawn(
    node,
    [join(companion, 'server/index.js'), '--config', config],
    {
      ...options,
      env: { ...env, ADE_COMPANION_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let logs = ''
  server.stdout.on('data', (data) => {
    logs = (logs + data).slice(-10_000)
  })
  server.stderr.on('data', (data) => {
    logs = (logs + data).slice(-10_000)
  })
  let failure
  server.on('error', (error) => {
    failure = error
  })
  const deadline = Date.now() + 20_000
  while (!socket) {
    assert.ifError(failure)
    assert.equal(server.exitCode, null, logs)
    assert.ok(Date.now() < deadline, logs)
    const candidate = new WebSocket(`ws://127.0.0.1:${port}/companion`)
    try {
      const [message] = await once(candidate, 'message', {
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(JSON.parse(message.toString()).type, 'hello')
      socket = candidate
    } catch {
      candidate.on('error', () => {})
      candidate.terminate()
      await delay(100)
    }
  }
  const reply = once(socket, 'message', { signal: AbortSignal.timeout(5000) })
  socket.send(JSON.stringify({ type: 'worktrees:list', id: 'package-smoke' }))
  assert.equal(JSON.parse((await reply)[0].toString()).type, 'worktrees')

  const resources =
    platform === 'darwin'
      ? join(
          root,
          'dist',
          process.arch === 'arm64' ? 'mac-arm64' : 'mac',
          'ADE.app/Contents/Resources',
        )
      : join(
          root,
          'dist',
          `${platform === 'win32' ? 'win' : 'linux'}${process.arch === 'arm64' ? '-arm64' : ''}-unpacked/resources`,
        )
  const asar = join(resources, 'app.asar')
  const files = listPackage(asar).map((name) => name.replaceAll('\\', '/'))
  for (const path of [
    '/out/main/index.js',
    '/out/preload/index.mjs',
    '/out/renderer/index.html',
    '/node_modules/ws/package.json',
    '/node_modules/zod/package.json',
  ])
    assert.ok(files.includes(path), `Missing desktop asset: ${path}`)
  assert.ok(
    !files.some(
      (path) =>
        path.startsWith('/node_modules/cheerio/') ||
        path.startsWith('/out/server/'),
    ),
  )
  assert.equal(
    JSON.parse(extractFile(asar, 'package.json').toString()).version,
    app.version,
  )
  console.log(
    'Package smoke checks passed: extracted companion, bundled Node, CLI, extension setup, WebSocket connection, desktop assets and dependencies.',
  )
} finally {
  socket?.terminate()
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit')
    server.kill()
    await stopped
  }
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep))
  await rm(temporary, { recursive: true, force: true, maxRetries: 5 })
}
