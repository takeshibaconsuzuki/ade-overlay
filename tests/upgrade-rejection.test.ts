import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { test } from 'node:test'
import { startRpcServer } from '../src/server/server'
import { VscodeProxy } from '../src/server/vscode-proxy'

for (const [path, status] of [
  ['/unknown', '404 Not Found'],
  [`/vscode/${'a'.repeat(64)}/`, '503 Service Unavailable'],
]) {
  test(
    `rejected upgrade ${status} flushes its response and permits shutdown with a half-open client`,
    { timeout: 3000 },
    async (t) => {
      const server = await startRpcServer(
        {},
        { host: '127.0.0.1', port: 0 },
        undefined,
        new VscodeProxy({ getTarget: () => undefined }),
      )
      const client = createConnection({
        host: '127.0.0.1',
        port: server.port,
        allowHalfOpen: true,
      })
      t.after(async () => {
        client.destroy()
        await server.close()
      })
      let response = ''
      client.setEncoding('utf8')
      client.on('data', (data: string) => {
        response += data
      })
      const ended = once(client, 'end', { signal: t.signal })
      await once(client, 'connect', { signal: t.signal })
      client.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      )
      await ended
      assert.equal(response, `HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
      assert.equal(client.writable, true)
      // Leave our sending side open: shutdown must not depend on the client closing it.
      await server.close()
    },
  )
}
