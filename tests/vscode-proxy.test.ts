import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { test, type TestContext } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { VscodeProxy } from '../src/server/vscode-proxy'
import { startRpcServer } from '../src/server/server'
import { connectRpc } from '../src/shared/rpc-client'
import { setTimeout as delay } from 'node:timers/promises'

const base = `/vscode/${'a'.repeat(64)}`

for (const completeHandshake of [false, true]) {
  test(
    `shutdown cancels an upstream upgrade ${completeHandshake ? 'that responds after shutdown' : 'that never responds'}`,
    { timeout: 3000 },
    async (t) => {
      const upstream = createServer()
      const connections = new Set<Socket>()
      upstream.on('connection', (socket) => {
        connections.add(socket)
        socket.once('close', () => connections.delete(socket))
      })
      t.after(async () => {
        for (const socket of connections) socket.destroy()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      })
      upstream.listen(0, '127.0.0.1')
      await once(upstream, 'listening')
      const address = upstream.address()
      assert.ok(address && typeof address !== 'string')
      const server = await startRpcServer(
        {},
        { host: '127.0.0.1', port: 0 },
        undefined,
        new VscodeProxy({
          getTarget: () => `http://127.0.0.1:${address.port}`,
        }),
      )
      const client = createConnection({ host: '127.0.0.1', port: server.port })
      t.after(async () => {
        client.destroy()
        await server.close()
      })
      client.resume()
      const upgrading = once(upstream, 'upgrade', { signal: t.signal })
      await once(client, 'connect', { signal: t.signal })
      client.write(
        `GET ${base}/ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      )
      const [, socket] = await upgrading
      // Observe cancellation even while the upstream has not sent a response.
      socket.resume()
      socket.on('error', () => {})
      socket.once('end', () => socket.destroy())
      const closed = new Promise<void>((resolve) =>
        socket.once('close', resolve),
      )
      await server.close()
      if (completeHandshake) {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n',
        )
      }
      await closed
    },
  )
}

async function fixture(t: TestContext) {
  const requests: {
    url?: string
    host?: string
    forwarded?: string | string[]
  }[] = []
  const upstream = createServer((request, response) => {
    requests.push({
      url: request.url,
      host: request.headers.host,
      forwarded: request.headers['x-forwarded-host'],
    })
    const url = new URL(request.url!, 'http://local')
    if (
      url.searchParams.get('tkn') !== 'secret' &&
      request.headers.cookie !== 'vscode-tkn=secret'
    ) {
      response.writeHead(403).end('Forbidden')
    } else if (url.pathname === `${base}/`) {
      response
        .writeHead(302, {
          Location: base,
          'Set-Cookie': 'vscode-tkn=secret; SameSite=Lax',
        })
        .end()
    } else {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end(request.url)
    }
  })
  const sockets = new WebSocketServer({ server: upstream })
  sockets.on('connection', (socket) =>
    socket.on('message', (data) => socket.send(data)),
  )
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  let target: string | undefined = `http://127.0.0.1:${address.port}`
  const proxy = new VscodeProxy({
    getTarget: (route) => (route === base ? target : undefined),
  })
  const server = await startRpcServer(
    { value: () => 42 },
    { host: '127.0.0.1', port: 0 },
    undefined,
    proxy,
  )
  t.after(async () => {
    await server.close()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => sockets.close(() => resolve()))
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve())
      upstream.closeAllConnections()
    })
  })
  return {
    server,
    requests,
    url: `http://127.0.0.1:${server.port}`,
    setTarget: (value: string | undefined) => {
      target = value
    },
  }
}

test('proxy preserves routes, public authority, redirects and authentication', async (t) => {
  const f = await fixture(t)
  const missing = await fetch(`${f.url}${base}/`)
  assert.equal(missing.status, 403)
  const redirect = await fetch(`${f.url}${base}/?tkn=secret`, {
    redirect: 'manual',
  })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), base)
  assert.match(redirect.headers.get('set-cookie')!, /vscode-tkn=secret/)
  const asset = await fetch(`${f.url}${base}/static/test.js?query=keep`, {
    headers: {
      Cookie: 'vscode-tkn=secret',
      'X-Forwarded-Host': 'attacker.example',
    },
  })
  assert.equal(asset.status, 200)
  assert.equal(await asset.text(), `${base}/static/test.js?query=keep`)
  assert.equal(f.requests.at(-1)?.host, new URL(f.url).host)
  assert.equal(f.requests.at(-1)?.forwarded, undefined)
  f.setTarget(undefined)
  assert.equal((await fetch(`${f.url}${base}/`)).status, 503)
  f.setTarget('http://127.0.0.1:1')
  assert.equal((await fetch(`${f.url}${base}/`)).status, 502)
})

test(
  'RPC and proxied WebSockets coexist and disconnect independently; shutdown closes both',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t)
    const socket = new WebSocket(
      `${f.url.replace('http:', 'ws:')}${base}/?reconnectionToken=test`,
    )
    t.after(() => socket.terminate())
    await once(socket, 'open')
    const client = connectRpc<{ value(): number }, object>(
      `${f.url.replace('http:', 'ws:')}/rpc`,
      {},
    )
    t.after(() => client.close())
    while (client.state !== 'connected') await delay(5)
    assert.equal(await client.rpc.value(), 42)
    await client.close()
    const message = once(socket, 'message')
    socket.send('still connected')
    assert.equal(String((await message)[0]), 'still connected')
    const closed = once(socket, 'close')
    await f.server.close()
    await closed
  },
)
