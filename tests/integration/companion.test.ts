import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { connect, type Socket } from 'node:net'
import { test, type TestContext } from 'node:test'
import { WebSocket } from 'ws'
import type { Socket as Peer } from 'socket.io'
import { socketServer, socketPeer } from '../helpers/socket.ts'
import { CompanionClient } from '../../src/main/companion-client.ts'
import { startCompanionServer } from '../../src/server/server.ts'
import { MAX_MESSAGE_BYTES } from '../../src/shared/companion.ts'
import { companionRequests } from '../../src/shared/companion.ts'
import { callRpc } from '../../src/shared/rpc.ts'
import type { CompanionStatus } from '../../src/shared/ipc.ts'

function waitForStatus(
  client: CompanionClient,
  state: CompanionStatus['state'],
): Promise<CompanionStatus> {
  if (client.getStatus().state === state)
    return Promise.resolve(client.getStatus())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('status', listener)
      reject(
        new Error(
          `Timed out waiting for ${state}: ${JSON.stringify(client.getStatus())}`,
        ),
      )
    }, 3_000)
    const listener = (status: CompanionStatus): void => {
      if (status.state !== state) return
      clearTimeout(timer)
      client.off('status', listener)
      resolve(status)
    }
    client.on('status', listener)
  })
}

function makeClient(
  t: TestContext,
  url: string,
  extra: ConstructorParameters<typeof CompanionClient>[0] = {},
): CompanionClient {
  const client = new CompanionClient({
    url,
    reconnectDelayMs: 20,
    maxReconnectDelayMs: 40,
    requestTimeoutMs: 200,
    ...extra,
  })
  t.after(() => client.stop())
  return client
}

async function fixture(
  t: TestContext,
  onConnect: (socket: Peer) => void,
): Promise<string> {
  return (await socketServer(t, onConnect)).url
}

const emptySnapshot = { revision: 1, projects: [], worktrees: [] }

const hello = { protocolVersion: 1 }

for (const ending of ['timeout', 'disconnect']) {
  test(
    `cancelled acknowledgements release capacity on ${ending}`,
    { timeout: 5000 },
    async (t) => {
      let count = 0
      let receivedAll!: () => void
      const received = new Promise<void>((resolve) => {
        receivedAll = resolve
      })
      const { url } = await socketServer(t, (peer) => {
        peer.on('companionStartEditorServer', () => {
          if (++count === 32) receivedAll()
        })
        peer.on('companionListWorktrees', (_input, ack) =>
          ack({ ok: true, value: emptySnapshot }),
        )
      })
      const { socket } = await socketPeer(t, url)
      for (let i = 0; i < 32; i++) {
        const controller = new AbortController()
        const request = callRpc(
          socket,
          companionRequests.companionStartEditorServer,
          { project: '/project', path: '/project' },
          { signal: controller.signal, timeout: 1000 },
        )
        controller.abort()
        await assert.rejects(request, { name: 'AbortError' })
      }
      await received
      await assert.rejects(
        callRpc(socket, companionRequests.companionListWorktrees, null),
        /Too many pending requests/,
      )
      if (ending === 'timeout') await delay(1100)
      else {
        socket.disconnect()
        const connected = new Promise<void>((resolve) =>
          socket.once('connect', resolve),
        )
        socket.connect()
        await connected
      }
      assert.deepEqual(
        await callRpc(socket, companionRequests.companionListWorktrees, null),
        emptySnapshot,
      )
    },
  )
}

test('cancelled editor requests keep acknowledgement capacity until late replies settle', async (t) => {
  const requests: ((reply: unknown) => void)[] = []
  let receivedAll!: () => void
  const received = new Promise<void>((resolve) => {
    receivedAll = resolve
  })
  let peer!: Peer
  const url = await fixture(t, (connected) => {
    peer = connected
    peer.emit('hello', hello)
    peer.on('companionStartEditorServer', (_input, ack) => {
      requests.push(ack)
      if (requests.length === 32) receivedAll()
    })
    peer.on('companionListWorktrees', (_input, ack) =>
      ack({ ok: true, value: emptySnapshot }),
    )
  })
  const client = makeClient(t, url, { requestTimeoutMs: 5000 })
  client.connect()
  await waitForStatus(client, 'connected')
  const worktree = { project: '/project', path: '/project/branch' }
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(
    client.companionStartEditorServer(worktree, stopped.signal),
    {
      name: 'AbortError',
    },
  )
  for (let i = 0; i < 32; i++) {
    const controller = new AbortController()
    const opening = client.companionStartEditorServer(
      worktree,
      controller.signal,
    )
    controller.abort()
    await assert.rejects(opening, { name: 'AbortError' })
  }
  await received
  await assert.rejects(
    client.companionListWorktrees(),
    /Too many pending requests/,
  )
  for (let i = 0; i < 8; i++)
    await assert.rejects(
      client.companionStartEditorServer(worktree),
      /Too many pending requests/,
    )
  assert.equal(requests.length, 32)
  requests.forEach((reply, index) =>
    reply(
      index % 2
        ? { ok: false, error: 'Late startup error' }
        : {
            ok: true,
            value: { id: 'a'.repeat(64), accessToken: 'b'.repeat(64) },
          },
    ),
  )
  // The same ordered stream delivers this notification after the late replies.
  const settled = once(client, 'desktopUpdateWorktrees')
  peer.emit('desktopUpdateWorktrees', emptySnapshot)
  await settled
  await client.companionListWorktrees()
  assert.equal(client.getStatus().state, 'connected')
})

test(
  'multiple clients exchange correlated list requests with the standalone server',
  { timeout: 5_000 },
  async (t) => {
    const server = await startCompanionServer({
      config: { projects: [] },
      port: 0,
    })
    t.after(() => server.close())
    const clients = [makeClient(t, server.url), makeClient(t, server.url)]
    for (const client of clients) client.connect()
    await Promise.all(
      clients.map((client) => waitForStatus(client, 'connected')),
    )
    const results = await Promise.all([
      clients[0].companionListWorktrees(),
      clients[0].companionListWorktrees(),
      clients[1].companionListWorktrees(),
    ])
    for (const result of results) {
      assert.deepEqual(result, emptySnapshot)
    }
  },
)

test(
  'server rejects invalid requests and limits message size',
  { timeout: 5000 },
  async (t) => {
    const server = await startCompanionServer({
      config: { projects: [] },
      port: 0,
    })
    t.after(() => server.close())
    const { socket } = await socketPeer(t, server.url)
    for (const input of ['{', [], { project: 'repo' }, Buffer.from('binary')]) {
      const reply = await socket
        .timeout(1000)
        .emitWithAck('companionCreateWorktree', input)
      assert.equal(reply.ok, false)
    }
    assert.equal(
      (await socket.timeout(1000).emitWithAck('unknown', null)).ok,
      false,
    )
    assert.deepEqual(
      await socket.timeout(1000).emitWithAck('companionListWorktrees', null),
      { ok: true, value: emptySnapshot },
    )
    const closed = new Promise<void>((resolve) =>
      socket.once('disconnect', () => resolve()),
    )
    socket.emit('companionListWorktrees', 'x'.repeat(MAX_MESSAGE_BYTES + 1))
    await closed
  },
)

test(
  'server checks the endpoint, browser origin, and optional authentication token',
  { timeout: 5_000 },
  async (t) => {
    const server = await startCompanionServer({
      config: { projects: [] },
      port: 0,
      token: 'test-secret',
    })
    t.after(() => server.close())
    const cases = [
      {
        url: server.url.replace('/companion', '/wrong'),
        headers: {},
        status: 404,
      },
      {
        url: server.url,
        headers: { Origin: 'https://example.com' },
        status: 403,
      },
      { url: server.url, headers: {}, status: 401 },
      {
        url: server.url,
        headers: { Authorization: 'Bearer wrong-secret' },
        status: 401,
      },
    ]
    for (const entry of cases) {
      const socket = new WebSocket(entry.url, { headers: entry.headers })
      t.after(() => socket.terminate())
      await new Promise<void>((resolve, reject) => {
        socket.on('error', (error) => {
          try {
            assert.match(error.message, new RegExp(String(entry.status)))
            resolve()
          } catch (cause) {
            reject(cause)
          }
        })
        socket.on('open', () =>
          reject(new Error('Unexpected accepted connection')),
        )
      })
    }
    const client = makeClient(t, server.url, { token: 'test-secret' })
    client.connect()
    await waitForStatus(client, 'connected')
    await client.companionListWorktrees()
  },
)

test(
  'rejected half-open upgrade sockets do not block server shutdown',
  { timeout: 5_000 },
  async (t) => {
    const server = await startCompanionServer({
      config: { projects: [] },
      port: 0,
      token: 'test-secret',
    })
    const url = new URL(server.url)
    const peers: Socket[] = []
    t.after(async () => {
      for (const peer of peers) peer.destroy()
      await server.close()
    })

    const cases = [
      { path: '/wrong', headers: [], status: '404 Not Found' },
      {
        path: `/editors/${'a'.repeat(64)}/`,
        headers: [],
        status: '403 Forbidden',
      },
      {
        path: '/companion',
        headers: ['Origin: https://example.com'],
        status: '403 Forbidden',
      },
      { path: '/companion', headers: [], status: '401 Unauthorized' },
    ]
    for (const entry of cases) {
      const peer = connect({
        host: url.hostname,
        port: Number(url.port),
        allowHalfOpen: true,
      })
      peers.push(peer)
      let response = ''
      peer.setEncoding('utf8')
      peer.on('data', (chunk) => {
        response += chunk
      })
      await once(peer, 'connect', { signal: t.signal })
      const ended = once(peer, 'end', { signal: t.signal })
      peer.write(
        [
          `GET ${entry.path} HTTP/1.1`,
          `Host: ${url.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          ...entry.headers,
          '',
          '',
        ].join('\r\n'),
      )
      await ended
      assert.equal(
        response,
        `HTTP/1.1 ${entry.status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
      assert.equal(peer.writable, true)
    }

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        server.close(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error('Rejected upgrade sockets blocked server shutdown.'),
              ),
            1_000,
          )
        }),
      ])
      // Shutdown must finish without the rejected peers closing their write sides.
      for (const peer of peers) assert.equal(peer.writable, true)
    } finally {
      clearTimeout(timeout)
    }
  },
)

test(
  'client reconnects when the server starts later and after a server restart',
  { timeout: 5_000 },
  async (t) => {
    const initial = await startCompanionServer({
      config: { projects: [] },
      port: 0,
    })
    const url = initial.url
    const port = Number(new URL(url).port)
    await initial.close()
    const client = makeClient(t, url)
    client.connect()
    assert.ok((await waitForStatus(client, 'reconnecting')).error)
    const server = await startCompanionServer({
      config: { projects: [] },
      port,
    })
    t.after(() => server.close())
    await waitForStatus(client, 'connected')
    await client.companionListWorktrees()
    await server.close()
    await waitForStatus(client, 'reconnecting')
    const restarted = await startCompanionServer({
      config: { projects: [] },
      port,
    })
    t.after(() => restarted.close())
    await waitForStatus(client, 'connected')
    await client.companionListWorktrees()
    client.stop()
    assert.equal(client.getStatus().state, 'disconnected')
    await assert.rejects(client.companionListWorktrees(), /Connect to/)
  },
)

test('shutdown cancels retries', { timeout: 5_000 }, async (t) => {
  const server = await startCompanionServer({
    config: { projects: [] },
    port: 0,
  })
  t.after(() => server.close())
  const client = makeClient(t, server.url)
  client.connect()
  await waitForStatus(client, 'connected')
  await client.companionListWorktrees()
  await server.close()
  await waitForStatus(client, 'reconnecting')
  client.stop()
  const states: string[] = []
  client.on('status', (status) => states.push(status.state))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(states, [])
})

test(
  'force reconnect replaces the connection at the configured URL',
  { timeout: 5_000 },
  async (t) => {
    const sockets: Peer[] = []
    const url = await fixture(t, (socket) => {
      sockets.push(socket)
      socket.emit('hello', hello)
    })
    const client = makeClient(t, url)
    client.connect()
    await waitForStatus(client, 'connected')
    const pending = assert.rejects(
      client.companionListWorktrees(),
      /Disconnected/,
    )
    const closed = once(sockets[0], 'disconnect')
    client.connect()
    assert.equal(client.getStatus().state, 'connecting')
    await Promise.all([closed, pending, waitForStatus(client, 'connected')])
    assert.equal(sockets.length, 2)
    assert.equal(client.getStatus().url, url)
  },
)

test(
  'a remote disconnect triggers a new connection without restarting the server',
  { timeout: 5_000 },
  async (t) => {
    const sockets: Peer[] = []
    const url = await fixture(t, (socket) => {
      sockets.push(socket)
      socket.emit('hello', hello)
    })
    const client = makeClient(t, url)
    client.connect()
    await waitForStatus(client, 'connected')
    sockets[0].conn.close()
    await waitForStatus(client, 'reconnecting')
    await waitForStatus(client, 'connected')
    assert.equal(sockets.length, 2)
    assert.equal(client.getStatus().url, url)
  },
)

test(
  'list requests time out and are rejected promptly on disconnect',
  { timeout: 5_000 },
  async (t) => {
    const url = await fixture(t, (socket) => socket.emit('hello', hello))
    const client = makeClient(t, url, { requestTimeoutMs: 50 })
    client.connect()
    await waitForStatus(client, 'connected')
    await assert.rejects(client.companionListWorktrees(), /timed out/)
    const pending = assert.rejects(
      client.companionListWorktrees(),
      /Disconnected/,
    )
    client.stop()
    await pending
  },
)

test(
  'client rejects missing, incompatible, and malformed handshakes',
  { timeout: 5_000 },
  async (t) => {
    const messages = [undefined, '{', { protocolVersion: 999 }]
    for (const message of messages) {
      const url = await fixture(t, (socket) => {
        if (message) socket.emit('hello', message)
      })
      const client = makeClient(t, url, { requestTimeoutMs: 50 })
      client.connect()
      const status = await waitForStatus(client, 'reconnecting')
      assert.match(
        status.error ?? '',
        /handshake timed out|Invalid message|Incompatible companion/,
      )
      client.stop()
    }
  },
)

test(
  'client detects a connection that stops responding to heartbeats',
  { timeout: 5000 },
  async (t) => {
    let peer!: Peer
    const { url } = await socketServer(
      t,
      (socket) => {
        peer = socket
        socket.emit('hello', hello)
      },
      { pingInterval: 20, pingTimeout: 20 },
    )
    const client = makeClient(t, url)
    client.connect()
    await waitForStatus(client, 'connected')
    t.mock.method(peer.conn.transport, 'send', () => {})
    assert.match(
      (await waitForStatus(client, 'reconnecting')).error ?? '',
      /ping timeout|transport close/,
    )
  },
)
