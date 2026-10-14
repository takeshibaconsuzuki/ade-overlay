import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, test, type TestContext } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { startRpcServer } from '../src/server/server'
import { serverOptionsSchema } from '../src/server/options'
import { connectRpc } from '../src/shared/rpc-client'
import { CONNECT_TIMEOUT_MS, RETRY_MAX_DELAY_MS } from '../src/shared/constants'
import { HEARTBEAT_INTERVAL_MS, RPC_PATH } from '../src/shared/constants'

async function waitFor(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Condition did not become true')
    await delay(10)
  }
}

async function pair<Server extends object, Client extends object>(
  t: TestContext,
  methods: Server,
  clientMethods: Client,
) {
  const server = await startRpcServer<Client, Server>(
    methods,
    serverOptionsSchema.parse({
      host: '127.0.0.1',
      port: 0,
    }),
  )
  t.after(() => server.close())
  const client = connectRpc<Server, Client>(
    `ws://127.0.0.1:${server.port}${RPC_PATH}`,
    clientMethods,
  )
  t.after(() => client.close())
  await waitFor(() => client.state === 'connected')
  return { server, client }
}

describe('RPC', { concurrency: true }, () => {
  test(
    'shutdown closes incomplete HTTP connections and upgraded clients',
    { timeout: 3000 },
    async (t) => {
      const server = await startRpcServer({}, { host: '127.0.0.1', port: 0 })
      const incomplete = createConnection({
        host: '127.0.0.1',
        port: server.port,
      })
      t.after(async () => {
        incomplete.destroy()
        await server.close()
      })
      await once(incomplete, 'connect')
      incomplete.write(`GET ${RPC_PATH} HTTP/1.1\r\nHost: localhost\r\n`)
      const upgraded = new WebSocket(`ws://127.0.0.1:${server.port}${RPC_PATH}`)
      await once(upgraded, 'open')
      assert.equal(server.clients.size, 1)

      const incompleteClosed = once(incomplete, 'close', { signal: t.signal })
      const upgradedClosed = once(upgraded, 'close', { signal: t.signal })
      const closing = server.close()
      assert.equal(server.close(), closing)
      await Promise.all([closing, incompleteClosed, upgradedClosed])
      assert.equal(server.clients.size, 0)
    },
  )

  test('typed calls work in both directions, concurrently, including void returns', async (t) => {
    const { server, client } = await pair(
      t,
      {
        async echo(value: string, milliseconds: number) {
          await delay(milliseconds)
          return { value }
        },
        finish() {},
      },
      { getName: () => 'desktop' },
    )
    assert.deepEqual(
      await Promise.all([
        client.rpc.echo('slow', 30),
        client.rpc.echo('fast', 0),
      ]),
      [{ value: 'slow' }, { value: 'fast' }],
    )
    assert.equal(await client.rpc.finish(), undefined)
    const [desktop] = server.clients
    assert.equal(await desktop.getName(), 'desktop')
  })

  test('structured arguments and results preserve nested errors and undefined values', async (t) => {
    const error = Object.assign(
      new TypeError('Invalid selection', {
        cause: new Error('Missing terminal'),
      }),
      { code: 'TERMINAL_NOT_FOUND' },
    )
    const payload = { error, optional: undefined, count: 1n, date: new Date() }
    const { client } = await pair(
      t,
      { echo: (value: typeof payload) => value },
      {},
    )
    const result = await client.rpc.echo(payload)
    assert.deepEqual(result, payload)
    assert.ok(result.error instanceof TypeError)
    assert.ok(result.error.cause instanceof Error)
    assert.equal(result.error.stack, error.stack)
    assert.equal(result.error.cause.stack, (error.cause as Error).stack)
  })

  test('remote exceptions preserve Error semantics, messages, codes, and causes', async (t) => {
    const { server, client } = await pair(
      t,
      {
        fail() {
          throw Object.assign(
            new TypeError('Project not found', {
              cause: new Error('Missing file'),
            }),
            {
              code: 'PROJECT_NOT_FOUND',
            },
          )
        },
        failWithNonError() {
          throw null
        },
      },
      {
        fail() {
          throw new Error('Desktop failure')
        },
      },
    )
    await assert.rejects(client.rpc.fail(), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'TypeError')
      assert.equal(error.message, 'Project not found')
      assert.equal(
        (error as Error & { code: string }).code,
        'PROJECT_NOT_FOUND',
      )
      assert.ok(error.cause instanceof Error)
      assert.equal(error.cause.message, 'Missing file')
      assert.match(error.stack ?? '', /rpc\.test\.ts/)
      return true
    })
    await assert.rejects(client.rpc.failWithNonError(), Error)
    const [desktop] = server.clients
    await assert.rejects(desktop.fail(), /Desktop failure/)
  })

  test('only explicitly exposed methods can be called', async (t) => {
    const { client } = await pair(t, { value: () => 42 }, {})
    await assert.rejects(
      client.rpc.$call('constructor' as 'value'),
      /not found/,
    )
    await assert.rejects(client.rpc.$call('toString' as 'value'), /not found/)
    assert.equal(await client.rpc.value(), 42)
  })

  test('calls have finite timeouts', async (t) => {
    const { client } = await pair(
      t,
      { hold: () => new Promise<void>(() => {}) },
      {},
    )
    await assert.rejects(client.rpc.hold(), /timeout/)
  })

  test('initial failures keep retrying, and shutdown stops retries', async (t) => {
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const address = reservation.address()
    assert.ok(address && typeof address === 'object')
    await new Promise<void>((resolve) => reservation.close(() => resolve()))

    let attempts = 0
    const client = connectRpc<{ value(): number }, object>(
      `ws://127.0.0.1:${address.port}${RPC_PATH}`,
      {},
      {
        onStateChange: (state) => {
          if (state === 'connecting') attempts++
        },
      },
    )
    t.after(() => client.close())
    await waitFor(() => attempts >= 4, RETRY_MAX_DELAY_MS)
    await assert.rejects(async () => client.rpc.value(), /not connected/)
    const server = await startRpcServer(
      { value: () => 42 },
      serverOptionsSchema.parse({ host: '127.0.0.1', port: address.port }),
    )
    t.after(() => server.close())
    await waitFor(() => client.state === 'connected', RETRY_MAX_DELAY_MS)
    assert.equal(await client.rpc.value(), 42)
    await server.close()
    await waitFor(() => client.state !== 'connected')
    await client.close()
    const stoppedAt = attempts
    await delay(RETRY_MAX_DELAY_MS + 100)
    assert.equal(attempts, stoppedAt)
    assert.equal(client.state, 'closed')
  })

  test('disconnect rejects pending calls and reconnect does not replay them', async (t) => {
    let executions = 0
    let finish: (() => void) | undefined
    const methods = {
      async hold() {
        executions++
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      },
      value: () => 42,
    }
    const { server, client } = await pair(t, methods, {})
    const oldRpc = client.rpc
    const pending = assert.rejects(oldRpc.hold(), /disconnected/)
    await waitFor(() => executions === 1)
    await server.close()
    await pending
    const replacement = await startRpcServer(
      methods,
      serverOptionsSchema.parse({
        host: '127.0.0.1',
        port: server.port,
      }),
    )
    t.after(() => replacement.close())
    await waitFor(() => client.state === 'connected')
    finish?.()
    assert.equal(await client.rpc.value(), 42)
    await assert.rejects(oldRpc.value(), /closed/)
    assert.equal(executions, 1)
  })

  test('client heartbeat detects a peer that stops responding and reconnects', async (t) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      autoPong: false,
    })
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    t.after(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate()
          server.close(() => resolve())
        }),
    )
    let connections = 0
    server.on('connection', () => connections++)
    const client = connectRpc(`ws://127.0.0.1:${address.port}${RPC_PATH}`, {})
    t.after(() => client.close())
    await waitFor(
      () => connections >= 2,
      2 * HEARTBEAT_INTERVAL_MS + RETRY_MAX_DELAY_MS,
    )
  })

  test('a stalled WebSocket handshake times out and retries', async (t) => {
    const sockets = new Set<import('node:net').Socket>()
    let connections = 0
    const server = createServer((socket) => {
      connections++
      sockets.add(socket)
      socket.on('data', () => {})
      socket.on('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    t.after(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => resolve())
        }),
    )
    const client = connectRpc(`ws://127.0.0.1:${address.port}${RPC_PATH}`, {})
    t.after(() => client.close())
    await waitFor(
      () => connections >= 3,
      3 * CONNECT_TIMEOUT_MS + RETRY_MAX_DELAY_MS,
    )
  })

  test('malformed messages close only the offending connection', async (t) => {
    const { server, client } = await pair(t, { value: () => 42 }, {})
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}${RPC_PATH}`)
    t.after(() => socket.terminate())
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send('{invalid json')
    await closed
    assert.equal(await client.rpc.value(), 42)
  })
})
