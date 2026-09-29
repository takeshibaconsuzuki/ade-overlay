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
import { io } from 'socket.io-client'

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
  assert.match(run(launcher, ['--help'], options), /--setup/)
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
  const extensions = join(home, 'custom extensions')
  await writeFile(
    config,
    JSON.stringify({
      projects: [],
      editor: { localExtensionsDir: extensions },
    }),
  )
  // Exercise extension setup with a local CLI fixture, including paths with spaces.
  const bin = join(home, 'Code bin')
  await mkdir(bin)
  const fakeCode = join(bin, 'cli.cjs')
  const record = join(home, 'installed.json')
  await writeFile(
    fakeCode,
    `const fs = require('node:fs'); const args = process.argv.slice(2); if (args.includes('--version')) console.log('1.138.0\\n${'a'.repeat(40)}\\nx64'); else if (args.includes('--help')) console.log('--cli-data-dir --connection-token-file --commit-id'); else { fs.accessSync(args[args.indexOf('--install-extension') + 1]); fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(args)); }`,
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
  run(launcher, ['--setup', '--config', config], {
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
  assert.ok(installed.includes(extensions))

  const hookFile = join(env.CODEX_HOME, 'hooks.json')
  const hooks = await readFile(hookFile, 'utf8')
  assert.match(hooks, /ADE chat activity/)
  const handlers = Object.values(JSON.parse(hooks).hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks),
  )
  const reporter = await realpath(
    join(companion, 'server', 'chats', 'chat-hook.js'),
  )
  for (const handler of handlers) {
    const command = handler.command
    assert.ok(command.includes(reporter))
    assert.ok(command.includes('runtime'))
  }
  run(node, [reporter, 'codex'], options)
  run(launcher, ['--setup', '--config', config], {
    ...options,
    env: { ...env, PATH: bin + (platform === 'win32' ? ';' : ':') + env.PATH },
  })
  assert.equal(await readFile(hookFile, 'utf8'), hooks, 'setup is idempotent')
  await writeFile(hookFile, '{malformed hooks')
  const invalidSetup = spawn.sync(launcher, ['--setup', '--config', config], {
    ...options,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...env, PATH: bin + (platform === 'win32' ? ';' : ':') + env.PATH },
  })
  assert.ifError(invalidSetup.error)
  assert.notEqual(invalidSetup.status, 0, 'setup reports malformed hooks')
  assert.equal(await readFile(hookFile, 'utf8'), '{malformed hooks')
  const bridge = await readFile(
    join(companion, 'assets', 'settings-sync.js'),
    'utf8',
  )
  assert.match(bridge, /adeSettingsSync/)

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
    const candidate = io(`http://127.0.0.1:${port}`, {
      path: '/companion',
      addTrailingSlash: false,
      transports: ['websocket'],
      reconnection: false,
    })
    try {
      const [message] = await once(candidate, 'hello', {
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(message.protocolVersion, 1)
      socket = candidate
    } catch {
      candidate.disconnect()
      await delay(100)
    }
  }
  const reply = await socket.timeout(5000).emitWithAck('worktrees:list', null)
  assert.equal(reply.ok, true)
  assert.ok(Array.isArray(reply.value.worktrees))
  assert.equal(
    await readFile(hookFile, 'utf8'),
    '{malformed hooks',
    'startup leaves hooks untouched',
  )

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
  if (platform === 'darwin')
    run('codesign', [
      '--verify',
      '--deep',
      '--strict',
      resolve(resources, '../..'),
    ])
  const asar = join(resources, 'app.asar')
  const files = listPackage(asar).map((name) => name.replaceAll('\\', '/'))
  for (const path of [
    '/out/main/index.js',
    '/out/preload/index.cjs',
    '/out/renderer/index.html',
    '/node_modules/socket.io-client/package.json',
    '/node_modules/ws/package.json',
    '/node_modules/zod/package.json',
    '/node_modules/koffi/package.json',
    `/node_modules/@koromix/koffi-${platform}-${process.arch}/package.json`,
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
    'Package smoke checks passed: extracted companion, bundled Node, CLI, explicit extension/hook setup, browser bridge, Socket.IO commands, desktop assets and dependencies.',
  )
} finally {
  socket?.disconnect()
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit')
    server.kill()
    await stopped
  }
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep))
  await rm(temporary, { recursive: true, force: true, maxRetries: 5 })
}
