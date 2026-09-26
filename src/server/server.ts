import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import {
  COMPANION_PROTOCOL_VERSION,
  DEFAULT_COMPANION_PORT,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  requestId,
  type ServerMessage,
} from '../shared/companion.ts'
import {
  loadServerConfig,
  serverConfigSchema,
  type ServerConfig,
} from './config.ts'
import { WorktreeStore } from './worktrees.ts'

export interface ServerOptions {
  host?: string
  port?: number
  token?: string
  heartbeatIntervalMs?: number
  configPath?: string
  config?: ServerConfig
}

function authorized(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function startCompanionServer(options: ServerOptions = {}) {
  // Finish config validation and discovery before binding any listening socket.
  const config =
    options.config === undefined
      ? await loadServerConfig(options.configPath)
      : serverConfigSchema.parse(options.config)
  const worktrees = await WorktreeStore.open(config.projects)
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? DEFAULT_COMPANION_PORT
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  })
  const alive = new Set<WebSocket>()
  worktrees.on('update', (update) => {
    const message: ServerMessage = { type: 'worktrees:updated', ...update }
    const data = JSON.stringify(message)
    for (const client of sockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data)
    }
  })
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      response.end(
        JSON.stringify({
          name: 'ade-companion',
          protocolVersion: COMPANION_PROTOCOL_VERSION,
        }),
      )
    } else {
      response.writeHead(404)
      response.end('Not found')
    }
  })

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy())
    // Native clients need no browser Origin. Reject browser-initiated connections.
    const status =
      request.url !== '/companion'
        ? '404 Not Found'
        : request.headers.origin !== undefined
          ? '403 Forbidden'
          : options.token &&
              !authorized(request.headers.authorization, options.token)
            ? '401 Unauthorized'
            : null
    if (status) {
      // Release upgrade sockets even when rejected peers keep their write side open.
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        () => socket.destroy(),
      )
      return
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      sockets.emit('connection', client, request)
    })
  })

  sockets.on('connection', (client) => {
    const send = (message: ServerMessage): void => {
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify(message))
    }
    alive.add(client)
    client.on('pong', () => alive.add(client))
    client.on('close', () => alive.delete(client))
    client.on('error', () => client.terminate())
    client.on('message', (data, isBinary) => {
      const message = isBinary ? null : parseClientMessage(data.toString())
      if (!message) {
        send({
          type: 'error',
          id: isBinary ? undefined : requestId(data.toString()),
          message:
            'Expected a supported JSON command with a non-empty id (up to 128 characters) and valid fields.',
        })
        return
      }
      if (message.type === 'ping') return send({ type: 'pong', id: message.id })
      if (message.type === 'worktrees:list')
        return send({
          type: 'worktrees',
          id: message.id,
          snapshot: worktrees.list(),
        })
      const operation =
        message.type === 'worktrees:create'
          ? worktrees.create(message.input)
          : message.type === 'worktrees:delete'
            ? worktrees.delete(message.input)
            : worktrees.refresh()
      void operation
        .then((snapshot) =>
          send({ type: 'worktrees', id: message.id, snapshot }),
        )
        .catch((error: unknown) => {
          send({
            type: 'error',
            id: message.id,
            message: error instanceof Error ? error.message : String(error),
          })
        })
    })
    send({
      type: 'hello',
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const heartbeat = setInterval(() => {
    for (const client of sockets.clients) {
      if (!alive.delete(client)) client.terminate()
      else client.ping()
    }
  }, options.heartbeatIntervalMs ?? 30_000)
  heartbeat.unref()

  const address = server.address() as AddressInfo
  const urlHost =
    address.family === 'IPv6' ? `[${address.address}]` : address.address
  let closing: Promise<void> | undefined
  return {
    url: `ws://${urlHost}:${address.port}/companion`,
    close(): Promise<void> {
      closing ??= (async () => {
        clearInterval(heartbeat)
        for (const client of sockets.clients) client.terminate()
        await new Promise<void>((resolve) => sockets.close(() => resolve()))
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
        await worktrees.settled()
      })()
      return closing
    },
  }
}
