import { createServer } from 'node:http'
import { EventEmitter, once } from 'node:events'
import type { TestContext } from 'node:test'
import { Server, type Socket, type ServerOptions } from 'socket.io'
import { createSocket } from '../../src/shared/node/socket-client.ts'
import type { eventSpec } from '../../src/shared/rpc.ts'

export async function socketServer(
  t: TestContext,
  connected: (socket: Socket) => void = () => {},
  options: Partial<ServerOptions> = {},
) {
  const http = createServer()
  const server = new Server(http, {
    path: '/companion',
    addTrailingSlash: false,
    transports: ['websocket'],
    serveClient: false,
    ...options,
  })
  server.on('connection', connected)
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  t.after(async () => {
    await server.close()
  })
  const address = http.address()
  if (!address || typeof address === 'string')
    throw new Error('No server address')
  return {
    server,
    url: `ws://127.0.0.1:${address.port}${options.path ?? '/companion'}`,
  }
}

export async function socketPeer(
  t: TestContext,
  url: string | URL,
  token?: string,
) {
  const socket = createSocket(String(url), { token, reconnectDelay: 20 })
  t.after(() => {
    socket.disconnect()
  })
  const messages: { event: string; value: unknown }[] = []
  const received = new EventEmitter()
  socket.onAny((event: string, value: unknown) => {
    messages.push({ event, value })
    received.emit('message')
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
    socket.connect()
  })
  return {
    socket,
    messages,
    async take<T>(spec: ReturnType<typeof eventSpec<T>>): Promise<T> {
      while (true) {
        const index = messages.findIndex(
          (message) => message.event === spec.event,
        )
        if (index >= 0)
          return spec.schema.parse(messages.splice(index, 1)[0].value)
        await once(received, 'message', { signal: t.signal })
      }
    },
  }
}
