import assert from 'node:assert/strict'
import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { test, type TestContext } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { CompanionClient } from '../src/main/companion-client.ts'
import { startCompanionServer } from '../src/server/server.ts'
import {
  MAX_MESSAGE_BYTES,
  type CompanionStatus,
} from '../src/shared/companion.ts'

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

async function rawClient(t: TestContext, url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  t.after(() => socket.terminate())
  const hello = once(socket, 'message')
  await once(socket, 'open')
  const [data] = await hello
  assert.deepEqual(JSON.parse(data.toString()), {
    type: 'hello',
    protocolVersion: 1,
  })
  return socket
}

async function fixture(
  t: TestContext,
  onConnect: (socket: WebSocket) => void,
): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', onConnect)
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address && typeof address !== 'string')
  return `ws://127.0.0.1:${address.port}/companion`
}

const hello = JSON.stringify({
  type: 'hello',
  protocolVersion: 1,
})

test(
  'standalone server health and multiple clients exchanging correlated pings',
  { timeout: 5_000 },
  async (t) => {
    const server = await startCompanionServer({ port: 0 })
    t.after(() => server.close())
    const health = await fetch(
      server.url.replace('ws:', 'http:').replace('/companion', '/health'),
    )
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
      name: 'ade-companion',
      protocolVersion: 1,
    })
    const clients = [makeClient(t, server.url), makeClient(t, server.url)]
    for (const client of clients) client.connect()
    await Promise.all(
      clients.map((client) => waitForStatus(client, 'connected')),
    )
    const results = await Promise.all([
      clients[0].ping(),
      clients[0].ping(),
      clients[1].ping(),
    ])
    for (const result of results) {
      assert.ok(result.roundTripMs >= 0)
    }
  },
)

test(
  'server rejects invalid requests and binary messages, and limits message size',
  { timeout: 5_000 },
  async (t) => {
    const server = await startCompanionServer({ port: 0 })
    t.after(() => server.close())
    const socket = await rawClient(t, server.url)
    for (const invalid of [
      '{',
      'null',
      '[]',
      '{"type":"unknown"}',
      '{"type":"ping","id":""}',
      Buffer.from('binary'),
    ]) {
      const reply = once(socket, 'message')
      socket.send(invalid)
      const [data] = await reply
      assert.equal(JSON.parse(data.toString()).type, 'error')
    }
    const reply = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'ping', id: 'still-alive' }))
    assert.deepEqual(JSON.parse((await reply)[0].toString()), {
      type: 'pong',
      id: 'still-alive',
    })
    const closed = once(socket, 'close')
    socket.send('x'.repeat(MAX_MESSAGE_BYTES + 1))
    assert.equal((await closed)[0], 1009)
  },
)

test(
  'server checks the endpoint, browser origin, and optional authentication token',
  { timeout: 5_000 },
  async (t) => {
    const server = await startCompanionServer({ port: 0, token: 'test-secret' })
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
    await client.ping()
  },
)

test(
  'rejected half-open upgrade sockets do not block server shutdown',
  { timeout: 5_000 },
  async (t) => {
    const server = await startCompanionServer({ port: 0, token: 'test-secret' })
    const url = new URL(server.url)
    const peers: Socket[] = []
    t.after(async () => {
      for (const peer of peers) peer.destroy()
      await server.close()
    })

    const cases = [
      { path: '/wrong', headers: [], status: '404 Not Found' },
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
    const initial = await startCompanionServer({ port: 0 })
    const url = initial.url
    const port = Number(new URL(url).port)
    await initial.close()
    const client = makeClient(t, url)
    client.connect()
    assert.ok((await waitForStatus(client, 'reconnecting')).error)
    const server = await startCompanionServer({ port })
    t.after(() => server.close())
    await waitForStatus(client, 'connected')
    await client.ping()
    await server.close()
    await waitForStatus(client, 'reconnecting')
    const restarted = await startCompanionServer({ port })
    t.after(() => restarted.close())
    await waitForStatus(client, 'connected')
    await client.ping()
    client.stop()
    assert.equal(client.getStatus().state, 'disconnected')
    await assert.rejects(client.ping(), /Connect to/)
  },
)

test('shutdown cancels retries', { timeout: 5_000 }, async (t) => {
  const server = await startCompanionServer({ port: 0 })
  t.after(() => server.close())
  const client = makeClient(t, server.url)
  client.connect()
  await waitForStatus(client, 'connected')
  await client.ping()
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
    const sockets: WebSocket[] = []
    const url = await fixture(t, (socket) => {
      sockets.push(socket)
      socket.send(hello)
    })
    const client = makeClient(t, url)
    client.connect()
    await waitForStatus(client, 'connected')
    const pending = assert.rejects(client.ping(), /Disconnected/)
    const closed = once(sockets[0], 'close')
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
    const sockets: WebSocket[] = []
    const url = await fixture(t, (socket) => {
      sockets.push(socket)
      socket.send(hello)
    })
    const client = makeClient(t, url)
    client.connect()
    await waitForStatus(client, 'connected')
    sockets[0].close(1000)
    await waitForStatus(client, 'reconnecting')
    await waitForStatus(client, 'connected')
    assert.equal(sockets.length, 2)
    assert.equal(client.getStatus().url, url)
  },
)

test(
  'invalid configured URLs remain in the retry loop without crashing',
  { timeout: 5_000 },
  async (t) => {
    for (const url of [
      'garbage',
      'https://localhost/companion',
      'ws://localhost/wrong',
      'ws://user:secret@localhost/companion',
    ]) {
      const client = makeClient(t, url)
      let failures = 0
      const retried = new Promise<void>((resolve) => {
        client.on('status', (status) => {
          if (
            status.state === 'reconnecting' &&
            status.error &&
            ++failures >= 3
          )
            resolve()
        })
      })
      assert.doesNotThrow(() => client.connect())
      await retried
      assert.equal(client.getStatus().url, url)
      assert.match(client.getStatus().error ?? '', /WebSocket URL|Use a ws/)
      client.stop()
    }
  },
)

test(
  'ping requests time out and are rejected promptly on disconnect',
  { timeout: 5_000 },
  async (t) => {
    const url = await fixture(t, (socket) => socket.send(hello))
    const client = makeClient(t, url, { requestTimeoutMs: 50 })
    client.connect()
    await waitForStatus(client, 'connected')
    await assert.rejects(client.ping(), /timed out/)
    const pending = assert.rejects(client.ping(), /Disconnected/)
    client.stop()
    await pending
  },
)

test(
  'client rejects missing, incompatible, and malformed handshakes',
  { timeout: 5_000 },
  async (t) => {
    const messages = [
      undefined,
      '{',
      JSON.stringify({
        type: 'hello',
        protocolVersion: 999,
      }),
    ]
    for (const message of messages) {
      const url = await fixture(t, (socket) => {
        if (message) socket.send(message)
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
  { timeout: 5_000 },
  async (t) => {
    // Disable automatic pong to simulate an unresponsive peer.
    const unresponsive = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      autoPong: false,
    })
    unresponsive.on('connection', (socket) => socket.send(hello))
    await once(unresponsive, 'listening')
    t.after(async () => {
      for (const socket of unresponsive.clients) socket.terminate()
      await new Promise<void>((resolve) => unresponsive.close(() => resolve()))
    })
    const address = unresponsive.address()
    assert.ok(address && typeof address !== 'string')
    const client = makeClient(t, `ws://127.0.0.1:${address.port}/companion`, {
      heartbeatIntervalMs: 20,
    })
    client.connect()
    await waitForStatus(client, 'connected')
    assert.match(
      (await waitForStatus(client, 'reconnecting')).error ?? '',
      /heartbeat timed out/,
    )
  },
)
