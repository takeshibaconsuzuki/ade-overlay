import { once } from 'node:events'
import { createServer, STATUS_CODES } from 'node:http'
import type { BirpcReturn } from 'birpc'
import { WebSocketServer } from 'ws'
import { MAX_RPC_PAYLOAD_BYTES, RPC_PATH } from '../shared/constants'
import { logger } from '../shared/logger'
import { createRpcPeer } from '../shared/rpc'
import type { ServerOptions } from './options'

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
): Promise<RpcServer<Remote, Local>> {
  const httpServer = createServer((_request, response) => {
    response.writeHead(426, { 'Content-Type': 'text/plain' })
    response.end(STATUS_CODES[426])
  })
  const server = new WebSocketServer({
    server: httpServer,
    path: RPC_PATH,
    maxPayload: MAX_RPC_PAYLOAD_BYTES,
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
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind a TCP port')
  }

  let closing: Promise<void> | undefined
  return {
    port: address.port,
    clients,
    close(): Promise<void> {
      closing ??= (async () => {
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
