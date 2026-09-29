import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { socketPeer } from '../helpers/socket.ts'
import { ChatService } from '../../src/server/chats/chat-service.ts'
import { EditorManager } from '../../src/server/editors/editor-manager.ts'
import { createEditorTransport } from '../../src/server/editors/editor-transport.ts'
import { EditorRuntimeManager } from '../../src/server/editors/vscode-runtime.ts'
import { SettingsSync } from '../../src/server/editors/settings-sync.ts'
import { silentLogger } from '../../src/server/logging.ts'
import { startCompanionServer } from '../../src/server/server.ts'

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

for (const path of ['', 'asset']) {
  for (const started of [false, true]) {
    test(
      `abandoning an editor ${path || 'document'} closes its upstream ${started ? 'body' : 'request'}`,
      { timeout: 5000 },
      async (t) => {
        const upstream = createServer((_request, response) => {
          if (started) {
            response.writeHead(200, { 'Content-Type': 'text/html' })
            response.write('<html>')
          }
        })
        const url = await listen(upstream)
        const transport = createEditorTransport({
          target: () => ({
            url,
            token: 'test',
            profile: { name: '', contents: '{}' },
            settings: new SettingsSync(
              join(tmpdir(), 'unused-settings.json'),
              silentLogger,
            ),
          }),
          activation: () => null,
          logger: silentLogger,
        })
        const server = createServer(transport.handleRequest)
        const origin = await listen(server)
        t.after(async () => {
          transport.close()
          server.closeAllConnections()
          upstream.closeAllConnections()
          await Promise.all([
            new Promise<void>((resolve) => server.close(() => resolve())),
            new Promise<void>((resolve) => upstream.close(() => resolve())),
          ])
        })
        const received = once(upstream, 'request', { signal: t.signal })
        const controller = new AbortController()
        const request = fetch(`${origin}/editors/${'a'.repeat(64)}/${path}`, {
          headers: { Authorization: 'Bearer test' },
          signal: controller.signal,
        }).then((response) => response.text())
        const failed = assert.rejects(request)
        const [, response] = await received
        const closed = once(response, 'close', {
          signal: AbortSignal.timeout(1000),
        })
        controller.abort()
        await Promise.all([failed, closed])
      },
    )
  }
}

for (const endpoint of ['desktop', 'extension']) {
  for (const connected of [false, true]) {
    test(
      `shutdown releases a stalled ${endpoint} ${connected ? 'connection' : 'Socket.IO handshake'} before editor cleanup`,
      { timeout: 5_000 },
      async (t) => {
        const services: ChatService[] = []
        const originalListen = ChatService.prototype.listen
        t.mock.method(
          ChatService.prototype,
          'listen',
          function (this: ChatService) {
            services.push(this)
            return originalListen.call(this)
          },
        )
        const runtime = new EditorRuntimeManager(tmpdir(), silentLogger)
        const editorCleanup = t.mock.method(runtime, 'close')
        const server = await startCompanionServer({
          config: { projects: [] },
          editorRuntime: runtime,
          port: 0,
        })
        const [chats] = services
        const peers: WebSocket[] = []
        t.after(async () => {
          for (const peer of peers) peer.terminate()
          await server.close()
        })
        let url = new URL(server.url)
        let token: string | undefined
        if (endpoint === 'extension') {
          const registration = chats.registerEditor('fixture', {
            project: '/project',
            path: '/project',
          })
          url = new URL(
            '/extension',
            registration.activityEnvironment.ADE_CHAT_ENDPOINT,
          )
          url.protocol = 'ws:'
          url.searchParams.set('activation', randomUUID())
          url.searchParams.set('startedAt', String(Date.now()))
          token = registration.controlToken
        }
        url.searchParams.set('EIO', '4')
        url.searchParams.set('transport', 'websocket')
        const socket = new WebSocket(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        peers.push(socket)
        await new Promise<void>((resolve, reject) => {
          socket.once('error', reject)
          socket.on('message', (data) => {
            const packet = data.toString()
            // Stop either after Engine.IO opens or after the application's
            // first event confirms the Socket.IO connection is registered.
            if (packet.startsWith('0')) {
              if (connected) socket.send('40')
              else resolve()
            } else if (packet.startsWith('42')) resolve()
          })
        })
        socket.pause() // Cannot read or answer a WebSocket closing handshake.
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            server.close(),
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(
                () => reject(new Error('Stalled peer delayed shutdown.')),
                1500,
              )
            }),
          ])
          assert.equal(editorCleanup.mock.callCount(), 1)
        } finally {
          clearTimeout(deadline)
          socket.terminate()
        }
      },
    )
  }
}

test('discovery failure closes owned services before listening', async (t) => {
  const editorRuntime = new EditorRuntimeManager(tmpdir(), silentLogger)
  const close = t.mock.method(editorRuntime, 'close')
  await assert.rejects(
    startCompanionServer({
      config: {
        projects: [{ mainWorktreePath: join(tmpdir(), randomUUID()) }],
      },
      editorRuntime,
      port: 0,
    }),
    { code: 'ENOENT' },
  )
  assert.equal(close.mock.callCount(), 1)
})

test(
  'public bind failure releases the loopback service and editor runtime',
  { timeout: 5_000 },
  async (t) => {
    const occupied = createServer()
    const address = await listen(occupied)
    t.after(
      () => new Promise<void>((resolve) => occupied.close(() => resolve())),
    )
    const editorRuntime = new EditorRuntimeManager(tmpdir(), silentLogger)
    const close = t.mock.method(editorRuntime, 'close')
    let endpoint = ''
    const originalListen = ChatService.prototype.listen
    t.mock.method(
      ChatService.prototype,
      'listen',
      async function (this: ChatService) {
        await originalListen.call(this)
        endpoint = this.registerEditor('fixture', {
          project: '/project',
          path: '/project',
        }).activityEnvironment.ADE_CHAT_ENDPOINT!
      },
    )
    await assert.rejects(
      startCompanionServer({
        config: { projects: [] },
        port: Number(new URL(address).port),
        editorRuntime,
      }),
      { code: 'EADDRINUSE' },
    )
    assert.ok(endpoint)
    await assert.rejects(fetch(endpoint))
    assert.equal(close.mock.callCount(), 1)
  },
)

test(
  'shutdown closes stalled document and asset requests, pending upgrades and connected peers',
  { timeout: 10_000 },
  async (t) => {
    const connections = new Set<Socket>()
    const upstream = createServer()
    upstream.on('connection', (socket) => {
      connections.add(socket)
      socket.once('close', () => connections.delete(socket))
    })
    const webSockets = new WebSocketServer({ noServer: true })
    upstream.on('upgrade', (request, socket, head) => {
      socket.on('error', () => socket.destroy())
      if (request.url?.endsWith('/ready'))
        webSockets.handleUpgrade(request, socket, head, () => {})
      else socket.resume()
    })
    const target = await listen(upstream)
    t.after(async () => {
      for (const socket of connections) socket.destroy()
      for (const socket of webSockets.clients) socket.terminate()
      await new Promise<void>((resolve) => webSockets.close(() => resolve()))
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    })
    const id = 'a'.repeat(64)
    const token = 'b'.repeat(64)
    t.mock.method(EditorManager.prototype, 'target', (editorId: string) =>
      editorId === id
        ? {
            url: target,
            token,
            profile: { name: '', contents: '{}' },
            settings: new SettingsSync(
              join(tmpdir(), 'unused-settings.json'),
              silentLogger,
            ),
          }
        : undefined,
    )
    const server = await startCompanionServer({
      config: { projects: [] },
      port: 0,
    })
    t.after(() => server.close())
    const editorUrl = new URL(
      `/editors/${id}/`,
      server.url.replace('ws:', 'http:'),
    )
    const headers = { Authorization: `Bearer ${token}` }
    const { socket: desktop } = await socketPeer(t, server.url)
    const ready = new WebSocket(
      new URL('ready', editorUrl).href.replace('http:', 'ws:'),
      { headers },
    )
    t.after(() => ready.terminate())
    await once(ready, 'open', { signal: t.signal })
    const desktopClosed = new Promise<void>((resolve) =>
      desktop.once('disconnect', () => resolve()),
    )
    const readyClosed = once(ready, 'close', { signal: t.signal })
    const finishedRequests: Promise<unknown>[] = []
    const closedResponses: Promise<unknown>[] = []
    for (const path of ['', 'asset']) {
      const received = once(upstream, 'request', { signal: t.signal })
      finishedRequests.push(
        assert.rejects(fetch(new URL(path, editorUrl), { headers })),
      )
      const [, response] = await received
      closedResponses.push(once(response, 'close', { signal: t.signal }))
    }
    const upgraded = once(upstream, 'upgrade', { signal: t.signal })
    const pending = new WebSocket(
      new URL('pending', editorUrl).href.replace('http:', 'ws:'),
      { headers },
    )
    t.after(() => pending.terminate())
    const pendingFailed = once(pending, 'error', { signal: t.signal })
    const [, upstreamSocket] = await upgraded
    const pendingEnded = once(upstreamSocket, 'end', { signal: t.signal })
    const closing = server.close()
    assert.equal(server.close(), closing)
    await closing
    await Promise.all([
      desktopClosed,
      readyClosed,
      pendingFailed,
      pendingEnded,
      ...finishedRequests,
      ...closedResponses,
    ])
    await server.close()
  },
)

test(
  'companion heartbeat drops an unresponsive desktop',
  { timeout: 5_000 },
  async (t) => {
    const server = await startCompanionServer({
      config: { projects: [] },
      port: 0,
      heartbeatIntervalMs: 20,
    })
    t.after(() => server.close())
    const peer = new WebSocket(`${server.url}?EIO=4&transport=websocket`)
    t.after(() => peer.terminate())
    const closed = once(peer, 'close', { signal: t.signal })
    await once(peer, 'open', { signal: t.signal })
    assert.ok([1000, 1005, 1006].includes((await closed)[0]))
  },
)
