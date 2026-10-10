import { once } from 'node:events'
import { createServer, STATUS_CODES } from 'node:http'
import { Socket } from 'node:net'
import type { BirpcReturn } from 'birpc'
import { WebSocketServer } from 'ws'
import { MAX_RPC_PAYLOAD_BYTES, RPC_PATH } from '../shared/constants'
import { logger } from '../shared/logger'
import { createRpcPeer } from '../shared/rpc'
import type { ServerOptions } from './options'
import type { ServerProxy } from './vscode-proxy'

const log = logger.child({ component: 'server' })

export interface RpcServer<Remote extends object, Local extends object> {
  readonly port: number
  readonly clients: ReadonlySet<BirpcReturn<Remote, Local>>
  close(): Promise<void>
}

export async function startRpcServer<
  Remote extends object,
  Local extends object,
>(
  methods: Local,
  options: Pick<ServerOptions, 'host' | 'port'>,
  onClient?: (client: BirpcReturn<Remote, Local>) => void,
  proxy?: ServerProxy,
): Promise<RpcServer<Remote, Local>> {
  const httpServer = createServer((request, response) => {
    if (proxy && request.url?.startsWith('/vscode/')) {
      proxy.request(request, response)
      return
    }
    response.writeHead(426, { 'Content-Type': 'text/plain' })
    response.end(STATUS_CODES[426])
  })
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RPC_PAYLOAD_BYTES,
  })
  httpServer.on('upgrade', (request, socket, head) => {
    if (!(socket instanceof Socket)) {
      socket.destroy()
      return
    }
    if (request.url?.split('?')[0] === RPC_PATH) {
      server.handleUpgrade(request, socket, head, (client) => {
        server.emit('connection', client, request)
      })
    } else if (proxy && request.url?.startsWith('/vscode/')) {
      proxy.upgrade(request, socket, head)
    } else {
      // Flush the rejection, then close both directions even if the peer stays half-open.
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n', () =>
        socket.destroy(),
      )
    }
  })
  const clients = new Set<BirpcReturn<Remote, Local>>()
  server.on('connection', (socket, request) => {
    const clientLog = log.child({
      remoteAddress: request.socket.remoteAddress,
      remotePort: request.socket.remotePort,
    })
    const rpc = createRpcPeer<Remote, Local>(socket, methods)
    clients.add(rpc)
    clientLog.info('Client connected')
    socket.once('close', (code, reason) => {
      clients.delete(rpc)
      clientLog.info({ code, reason: reason.toString() }, 'Client disconnected')
    })
    onClient?.(rpc)
  })
  httpServer.listen(options.port, options.host)
  await once(httpServer, 'listening')
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind a TCP port')
  }

  let closing: Promise<void> | undefined
  return {
    port: address.port,
    clients,
    close(): Promise<void> {
      closing ??= (async () => {
        proxy?.close()
        const httpClosed = new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()))
        })
        const webSocketsClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
        // Stop accepting connections before closing those still awaiting upgrade.
        httpServer.closeAllConnections()
        for (const socket of server.clients) socket.terminate()
        await Promise.all([httpClosed, webSocketsClosed])
      })()
      return closing
    },
  }
}
