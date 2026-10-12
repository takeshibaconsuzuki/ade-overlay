import { Socket } from 'node:net'
import type { BirpcReturn } from 'birpc'
import Fastify, { LogController, type FastifyPluginAsync } from 'fastify'
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
  // The signal ends the connection lifetime; initialization failures disconnect the peer.
  onClient?: (
    client: BirpcReturn<Remote, Local>,
    signal: AbortSignal,
  ) => void | Promise<void>,
  proxy?: ServerProxy,
  routes?: FastifyPluginAsync,
): Promise<RpcServer<Remote, Local>> {
  const app = Fastify({
    loggerInstance: log,
    logController: new LogController({ disableRequestLogging: true }),
    forceCloseConnections: true,
  })
  if (proxy) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.raw.url?.startsWith('/vscode/')) {
        // Hand off before body parsing so proxy uploads keep their original stream.
        reply.hijack()
        proxy.request(request.raw, reply.raw)
      }
    })
  }
  app.get(RPC_PATH, async (_request, reply) =>
    reply.code(426).type('text/plain').send('Upgrade Required'),
  )
  if (routes) app.register(routes)
  const httpServer = app.server
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
    const controller = new AbortController()
    clients.add(rpc)
    clientLog.info('Client connected')
    socket.once('close', (code, reason) => {
      clients.delete(rpc)
      controller.abort()
      clientLog.info({ code, reason: reason.toString() }, 'Client disconnected')
    })
    void Promise.resolve()
      .then(() => onClient?.(rpc, controller.signal))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          clientLog.warn({ err: error }, 'Client initialization failed')
        socket.terminate()
      })
  })
  app.addHook('preClose', async () => {
    proxy?.close()
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    for (const socket of server.clients) socket.terminate()
    await closed
  })
  try {
    await app.listen(options)
  } catch (error) {
    await app.close()
    throw error
  }
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind a TCP port')
  }

  let closing: Promise<void> | undefined
  return {
    port: address.port,
    clients,
    close(): Promise<void> {
      closing ??= app.close()
      return closing
    },
  }
}
