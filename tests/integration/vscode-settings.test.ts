import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import { test } from 'node:test'
import { createProxyServer } from 'httpxy'
import { simpleGit } from 'simple-git'
import { startIntegrationServer, runDesktopClient } from './harness'

test('VS Code shares host extensions and synchronizes user settings across reconnects', async () => {
  // Real workbenches and extensions, with disposable host files and a proxy that can disconnect
  // ADE's RPC while leaving the editors' own VS Code connections alive.
  const directory = await mkdtemp(join(tmpdir(), 'ade-settings-integration-'))
  console.log('Settings test data:', directory)
  const repos = ['alpha', 'beta'].map((name) => join(directory, name))
  for (const repo of repos) {
    await mkdir(repo)
    await simpleGit(repo).init()
  }
  const settingsFile = join(directory, 'settings.json')
  await writeFile(
    settingsFile,
    '{\n // host comment\n "editor.fontSize": 17,\n}\n',
  )
  const extensionsDirectory = join(directory, 'extensions')
  const extension = join(extensionsDirectory, 'ade-test.shared-1.0.0')
  await mkdir(extension, { recursive: true })
  await writeFile(
    join(extension, 'package.json'),
    JSON.stringify({
      name: 'shared',
      publisher: 'ade-test',
      version: '1.0.0',
      engines: { vscode: '^1.100.0' },
      main: './extension.js',
      activationEvents: ['*'],
    }),
  )
  await writeFile(
    join(extension, 'extension.js'),
    'exports.activate = () => {};\n',
  )
  const server = await startIntegrationServer(directory, repos)
  const proxy = createProxyServer({
    target: `http://127.0.0.1:${server.port}`,
    ws: true,
  })
  const sockets = new Set<Socket>()
  const rpcSockets = new Set<Socket>()
  let disconnected = false
  const gateway = createServer((request, response) => {
    if (
      request.url === '/test/disconnect' ||
      request.url === '/test/reconnect'
    ) {
      disconnected = request.url === '/test/disconnect'
      if (disconnected) for (const socket of rpcSockets) socket.destroy()
      response.end('ok')
      return
    }
    void proxy.web(request, response).catch(() => response.destroy())
  })
  gateway.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  proxy.on('open', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  proxy.on('proxyReqWs', (request, _incoming, socket) => {
    socket.once('close', () => request.destroy())
  })
  gateway.on('upgrade', (request, socket, head) => {
    if (!(socket instanceof Socket)) {
      socket.destroy()
      return
    }
    if (request.url === '/rpc') {
      if (disconnected) {
        socket.destroy()
        return
      }
      rpcSockets.add(socket)
      socket.once('close', () => rpcSockets.delete(socket))
    }
    void proxy.ws(request, socket, {}, head).catch(() => socket.destroy())
  })
  try {
    gateway.listen(0, '127.0.0.1')
    await once(gateway, 'listening')
    const address = gateway.address()
    assert.ok(address && typeof address !== 'string')
    await runDesktopClient(
      'settings',
      {
        ADE_SERVER_URL: `ws://127.0.0.1:${address.port}/rpc`,
        ADE_SETTINGS_TEST_URL: `http://127.0.0.1:${address.port}`,
        ADE_SETTINGS_TEST_DATA: directory,
      },
      120_000,
    )
  } finally {
    for (const socket of sockets) socket.destroy()
    proxy.close()
    gateway.close()
    await server.close()
  }
})
