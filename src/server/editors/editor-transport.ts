import {
  ServerResponse,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http'
import type { Duplex } from 'node:stream'
import { text } from 'node:stream/consumers'
import { createProxyServer } from 'http-proxy-3'
import decompressResponse from 'decompress-response'
import getRawBody from 'raw-body'
import { parseCookie, stringifyCookie } from 'cookie'
import type { Logger } from 'pino'
import type { EditorServerManager } from './editor-manager.ts'
import type { ChatService } from '../chats/chat-service.ts'
import { withImportedProfile } from './editor-page.ts'
import { settingsSyncScript } from './settings-sync-asset.ts'
import { MAX_SETTINGS_BYTES } from '../../shared/editor-settings.ts'
import { authorized, rejectUpgrade } from '../transport.ts'

interface EditorTransportOptions {
  target: EditorServerManager['target']
  activation: ChatService['activation']
  logger: Logger
}

// Owns editor-facing requests and proxy connections, independently of editor processes.
export function createEditorTransport(options: EditorTransportOptions) {
  const { logger } = options
  const shutdown = new AbortController()
  const proxy = createProxyServer({ ws: true })
  // Some downstream socket errors are emitted directly by the proxy, bypassing
  // per-request callbacks. Handle both HTTP and upgraded connections here.
  proxy.on('error', (error, request, response) => {
    if (shutdown.signal.aborted || response.destroyed) {
      response.destroy()
      return
    }
    const http = response instanceof ServerResponse
    logger.warn(
      { err: error, path: request.url?.split('?')[0] },
      http ? 'Editor HTTP proxy failed' : 'Editor WebSocket proxy failed',
    )
    if (http && !response.headersSent && !response.writableEnded) {
      response.writeHead(502)
      response.end('Editor unavailable. Open the worktree again.')
    } else response.destroy()
  })
  const editorSockets = new Set<Duplex>()
  const proxyRequests = new Set<ClientRequest>()
  const documents = new WeakMap<IncomingMessage, (html: string) => string>()
  const trackSocket = (socket: Duplex): void => {
    if (shutdown.signal.aborted) {
      socket.destroy()
      return
    }
    editorSockets.add(socket)
    socket.once('close', () => editorSockets.delete(socket))
  }
  const trackRequest = (
    request: ClientRequest,
    incoming: IncomingMessage,
    response: ServerResponse | Duplex,
  ): void => {
    if (shutdown.signal.aborted) {
      request.destroy()
      return
    }
    if (proxyRequests.has(request)) return
    proxyRequests.add(request)
    request.once('close', () => proxyRequests.delete(request))
    if (documents.has(incoming)) {
      const deadline = setTimeout(
        () => request.destroy(new Error('Editor document timed out.')),
        30_000,
      )
      request.once('close', () => clearTimeout(deadline))
      // Redirect-following requests also need release after a completed reply.
      response.once('close', () => request.destroy())
    }
  }
  // A WebSocket can still be waiting for its upstream upgrade during shutdown.
  // Own that request as well as both ends of completed proxy connections.
  proxy.on('proxyReq', trackRequest)
  proxy.on('proxyReqWs', trackRequest)
  proxy.on('open', trackSocket)
  proxy.on('proxyRes', (upstream, request, response) => {
    const transform = documents.get(request)
    if (!transform) return
    void (async () => {
      const decoded = decompressResponse(upstream)
      if (decoded !== upstream)
        upstream.once('error', (error) => decoded.destroy(error))
      const html = await text(decoded)
      if (shutdown.signal.aborted || response.destroyed) return
      const body = upstream.statusCode === 200 ? transform(html) : html
      for (const [name, value] of Object.entries(upstream.headers))
        if (
          value !== undefined &&
          ![
            'content-length',
            'content-encoding',
            'transfer-encoding',
            'connection',
          ].includes(name)
        )
          response.setHeader(name, value)
      response.setHeader('Cache-Control', 'no-store')
      response.writeHead(upstream.statusCode!)
      response.end(body)
    })().catch((error: Error) => proxy.emit('error', error, request, response))
  })
  const editorTarget = (request: IncomingMessage) => {
    const id = /^\/editors\/([a-f0-9]{64})\//.exec(request.url ?? '')?.[1]
    const target = id ? options.target(id) : undefined
    if (!target || !authorized(request.headers.authorization, target.token))
      return undefined
    const url = new URL(request.url!, 'http://localhost')
    url.searchParams.delete('tkn')
    request.url = url.pathname + url.search
    // Preserve VS Code preferences (including display language), replacing only
    // its authentication cookie. Keep other cookie values in their wire encoding.
    try {
      const cookies = parseCookie(request.headers.cookie ?? '', {
        decode: (value) => value,
      })
      cookies['vscode-tkn'] = target.token
      request.headers.cookie = stringifyCookie(cookies, {
        encode: (value) => value,
      })
    } catch {
      // Malformed browser cookies must not escape the HTTP/upgrade handler.
      return undefined
    }
    // Never forward the app's authorization header to the VS Code runtime.
    delete request.headers.authorization
    return target
  }

  function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (shutdown.signal.aborted) {
      response.writeHead(503).end('Companion is stopping')
      return
    }
    const target = editorTarget(request)
    if (!target) {
      response.writeHead(403)
      response.end('Editor access denied')
      return
    }
    const pathname = new URL(request.url!, 'http://localhost').pathname
    if (
      /^\/editors\/[a-f0-9]{64}\/ade-settings-sync(?:\.js)?$/.test(pathname)
    ) {
      response.setHeader('Cache-Control', 'no-store')
      if (pathname.endsWith('.js') && request.method === 'GET') {
        void settingsSyncScript()
          .then((script) => {
            if (shutdown.signal.aborted || response.destroyed) return
            response.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
            })
            response.end(script)
          })
          .catch((error: unknown) => {
            if (shutdown.signal.aborted || response.destroyed) return
            logger.error(
              { err: error },
              'Could not read the browser settings bridge',
            )
            response.writeHead(500).end('Browser settings bridge unavailable')
          })
      } else if (!pathname.endsWith('.js') && request.method === 'POST') {
        const settings = target.settings
        request.setTimeout(10_000, () => request.destroy())
        void (async () => {
          // JSON escaping can expand a UTF-8 settings file substantially.
          const body = await getRawBody(request, {
            limit: MAX_SETTINGS_BYTES * 6 + 1024,
            encoding: 'utf8',
          })
          let input: unknown
          try {
            input = JSON.parse(body)
          } catch {
            // JSON parser errors may quote settings containing credentials.
            throw new Error('Invalid settings sync JSON.')
          }
          const result = await settings.sync(input)
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(result))
        })().catch((error: unknown) => {
          if (shutdown.signal.aborted || response.destroyed) return
          // raw-body pauses failed reads; finish the reply before closing input.
          response.once('finish', () => request.destroy())
          response.setHeader('Connection', 'close')
          if (
            error instanceof Error &&
            'type' in error &&
            error.type === 'entity.too.large'
          ) {
            response.writeHead(413).end('Settings request too large')
            return
          }
          logger.warn(
            {
              message: error instanceof Error ? error.message : String(error),
            },
            'VS Code settings sync failed',
          )
          if (!response.headersSent) response.writeHead(400)
          response.end(
            'Could not synchronize VS Code settings; retrying on the next cycle.',
          )
        })
      } else response.writeHead(405).end('Method not allowed')
      return
    }
    const document =
      request.method === 'GET' && /^\/editors\/[a-f0-9]{64}\/$/.test(pathname)
    if (document) {
      documents.set(request, (html) =>
        withImportedProfile(
          html,
          target.profile,
          `${pathname}ade-settings-sync.js`,
          options.activation(pathname.split('/')[2]),
        ),
      )
      if (request.headers.host)
        request.headers['x-forwarded-host'] ||= request.headers.host
      request.headers['accept-encoding'] = 'gzip, deflate, br'
    }
    proxy.web(request, response, {
      target: target.url,
      selfHandleResponse: document,
      followRedirects: document,
      changeOrigin: document,
    })
  }

  function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (shutdown.signal.aborted) {
      rejectUpgrade(socket, '503 Service Unavailable')
      return
    }
    const target = editorTarget(request)
    if (!target) {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    trackSocket(socket)
    proxy.ws(request, socket, head, { target: target.url })
  }

  return {
    handleRequest,
    handleUpgrade,
    close(): void {
      if (shutdown.signal.aborted) return
      shutdown.abort()
      for (const request of proxyRequests) request.destroy()
      proxyRequests.clear()
      for (const socket of editorSockets) socket.destroy()
      editorSockets.clear()
      proxy.close()
    },
  }
}
