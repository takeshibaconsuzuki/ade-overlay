import { timingSafeEqual } from 'node:crypto'
import { createServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { createProxyServer } from 'http-proxy-3'
import { parseCookie, stringifyCookie } from 'cookie'
import type { Duplex } from 'node:stream'
import { EditorManager } from './editors.ts'
import type { EditorRuntimeManager } from './vscode-runtime.ts'
import { withImportedProfile } from './editor-page.ts'
import { settingsSyncScript } from './settings-sync-client.ts'
import { MAX_SETTINGS_BYTES } from '../shared/editor-settings.ts'
import type { Logger } from 'pino'
import { silentLogger } from './logging.ts'
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
import { ChatService } from './chat-service.ts'

export interface ServerOptions {
  editorRuntime?: EditorRuntimeManager
  logger?: Logger
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
  const logger = options.logger ?? silentLogger
  logger.info('Loading configuration and discovering worktrees')
  // Finish config validation and discovery before binding any listening socket.
  const config =
    options.config === undefined
      ? await loadServerConfig(options.configPath)
      : serverConfigSchema.parse(options.config)
  const chats = new ChatService(logger)
  const editors = new EditorManager(
    config.editor,
    logger,
    options.editorRuntime,
    chats,
  )
  const worktrees = await WorktreeStore.open(config.projects, editors)
  worktrees.on('operationFailed', (worktree, error) => {
    logger.error(
      { project: worktree.project, path: worktree.path, err: error },
      'Worktree operation failed',
    )
  })
  const proxy = createProxyServer({ ws: true })
  // Some downstream socket errors are emitted directly by the proxy, bypassing
  // per-request callbacks. Handle both HTTP and upgraded connections here.
  proxy.on('error', (error, request, response) => {
    const http = response instanceof ServerResponse
    logger.warn(
      { err: error, path: request.url?.split('?')[0] },
      http ? 'Editor HTTP proxy failed' : 'Editor WebSocket proxy failed',
    )
    if (response.destroyed) return
    if (http && !response.headersSent && !response.writableEnded) {
      response.writeHead(502)
      response.end('Editor unavailable. Open the worktree again.')
    } else response.destroy()
  })
  const editorSockets = new Set<Duplex>()
  const editorTarget = (request: import('node:http').IncomingMessage) => {
    const id = /^\/editors\/([a-f0-9]{64})\//.exec(request.url ?? '')?.[1]
    const target = id ? editors.target(id) : undefined
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
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? DEFAULT_COMPANION_PORT
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  })
  const alive = new Set<WebSocket>()
  const chatRequests = new Map<string, WebSocket>()
  chats.onNavigate = (id, input) => {
    const clients = [...sockets.clients].filter(
      (client) => client.readyState === WebSocket.OPEN,
    )
    if (clients.length !== 1)
      throw new Error(
        clients.length
          ? 'Chat navigation requires exactly one connected desktop.'
          : 'No desktop is connected.',
      )
    chatRequests.set(id, clients[0])
    clients[0].send(
      JSON.stringify({
        type: 'chat:activate',
        id,
        input,
      } satisfies ServerMessage),
    )
  }
  chats.onNavigationFinished = (id) => {
    const owner = chatRequests.get(id)
    chatRequests.delete(id)
    if (owner?.readyState === WebSocket.OPEN)
      owner.send(
        JSON.stringify({ type: 'chat:finished', id } satisfies ServerMessage),
      )
  }
  worktrees.on('update', (update) => {
    const message: ServerMessage = { type: 'worktrees:updated', ...update }
    const data = JSON.stringify(message)
    for (const client of sockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data)
    }
  })
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/editors/')) {
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
          response.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
          })
          response.end(settingsSyncScript())
        } else if (!pathname.endsWith('.js') && request.method === 'POST') {
          const settings = target.settings
          request.setTimeout(10_000, () => request.destroy())
          void (async () => {
            const chunks: Buffer[] = []
            let length = 0
            for await (const chunk of request) {
              length += chunk.length
              // JSON escaping can expand a UTF-8 settings file substantially.
              if (length > MAX_SETTINGS_BYTES * 6 + 1024) {
                response.writeHead(413).end('Settings request too large')
                return
              }
              chunks.push(chunk)
            }
            let input: unknown
            try {
              input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              // JSON parser errors may quote settings containing credentials.
              throw new Error('Invalid settings sync JSON.')
            }
            const result = await settings.sync(input)
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify(result))
          })().catch((error: unknown) => {
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
      const root = /^\/editors\/[a-f0-9]{64}\/$/.test(
        new URL(request.url!, 'http://localhost').pathname,
      )
      if (request.method === 'GET' && root) {
        const profile = target.profile
        const headers = new Headers()
        for (const [name, value] of Object.entries(request.headers)) {
          if (
            value === undefined ||
            [
              'connection',
              'transfer-encoding',
              'content-length',
              'accept-encoding',
            ].includes(name)
          )
            continue
          for (const item of Array.isArray(value) ? value : [value])
            headers.append(name, item)
        }
        // Fetch supplies the loopback Host header; VS Code needs the public
        // authority to keep browser resources and WebSockets on the proxy.
        if (!headers.has('x-forwarded-host') && request.headers.host)
          headers.set('x-forwarded-host', request.headers.host)
        void fetch(new URL(request.url!, target.url), {
          headers,
          signal: AbortSignal.timeout(30_000),
        })
          .then(async (upstream) => {
            const html = await upstream.text()
            const body =
              upstream.status === 200
                ? withImportedProfile(
                    html,
                    profile,
                    `${pathname}ade-settings-sync.js`,
                    chats.activation(pathname.split('/')[2]),
                  )
                : html
            for (const [name, value] of upstream.headers)
              if (
                ![
                  'content-length',
                  'content-encoding',
                  'transfer-encoding',
                  'connection',
                  'set-cookie',
                ].includes(name)
              )
                response.setHeader(name, value)
            const cookies = upstream.headers.getSetCookie()
            if (cookies.length) response.setHeader('Set-Cookie', cookies)
            response.setHeader('Cache-Control', 'no-store')
            response.writeHead(upstream.status)
            response.end(body)
          })
          .catch((error: unknown) => {
            logger.warn(
              { err: error },
              'Could not load editor with imported settings',
            )
            if (!response.headersSent) response.writeHead(502)
            response.end(
              'Could not load the editor settings. Open the worktree again to retry.',
            )
          })
        return
      }
      proxy.web(request, response, { target: target.url })
    } else {
      response.writeHead(404)
      response.end('Not found')
    }
  })

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy())
    if (request.url?.startsWith('/editors/')) {
      const target = editorTarget(request)
      if (!target) {
        socket.end(
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          () => socket.destroy(),
        )
        return
      }
      editorSockets.add(socket)
      socket.once('close', () => editorSockets.delete(socket))
      proxy.ws(request, socket, head, { target: target.url })
      return
    }
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
    logger.info('Companion client connected')
    const send = (message: ServerMessage): void => {
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify(message))
    }
    alive.add(client)
    client.on('pong', () => alive.add(client))
    client.on('close', (code) => {
      alive.delete(client)
      for (const [id, owner] of chatRequests)
        if (owner === client)
          chats.viewReady(id, 'Desktop disconnected. Try again.')
      logger.info({ code }, 'Companion client disconnected')
    })
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
      if (message.type === 'chat:view-ready') {
        if (chatRequests.get(message.id) === client)
          chats.viewReady(message.id, message.error, message.activationAfter)
        return
      }
      const started = performance.now()
      const requestLog = logger.child({
        command: message.type,
        requestId: message.id,
      })
      requestLog.info('Command received')
      if (message.type === 'worktrees:list')
        return send({
          type: 'worktrees',
          id: message.id,
          snapshot: worktrees.list(),
        })
      if (message.type === 'editor:open') {
        void worktrees
          .openEditor(message.input)
          .then((session) => {
            requestLog.info(
              {
                elapsedMs: Math.round(performance.now() - started),
                editorId: session.id,
              },
              'Editor ready',
            )
            send({ type: 'editor', id: message.id, session })
          })
          .catch((error: unknown) => {
            requestLog.error(
              {
                err: error,
                elapsedMs: Math.round(performance.now() - started),
              },
              'Editor open failed',
            )
            send({
              type: 'error',
              id: message.id,
              message: error instanceof Error ? error.message : String(error),
            })
          })
        return
      }
      const operation = Promise.resolve().then(() =>
        message.type === 'worktrees:create'
          ? worktrees.startCreate(message.input)
          : message.type === 'worktrees:delete'
            ? worktrees.startDelete(message.input)
            : message.type === 'worktrees:set-error'
              ? worktrees.setError(message.input)
              : worktrees.refresh(),
      )
      void operation
        .then((snapshot) => {
          requestLog.info(
            { elapsedMs: Math.round(performance.now() - started) },
            message.type === 'worktrees:create' ||
              message.type === 'worktrees:delete'
              ? 'Command accepted'
              : 'Command completed',
          )
          send({ type: 'worktrees', id: message.id, snapshot })
        })
        .catch((error: unknown) => {
          requestLog.error(
            { err: error, elapsedMs: Math.round(performance.now() - started) },
            'Command failed',
          )
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

  await chats.listen()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await chats.close()
    throw error
  }

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
    startEditorUpdates(): void {
      editors.startUpdates()
    },
    close(): Promise<void> {
      closing ??= (async () => {
        clearInterval(heartbeat)
        await chats.close()
        for (const socket of editorSockets) socket.destroy()
        for (const client of sockets.clients) client.terminate()
        await new Promise<void>((resolve) => sockets.close(() => resolve()))
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
        await worktrees.settled()
        try {
          await editors.close()
        } finally {
          proxy.close()
        }
      })()
      return closing
    },
  }
}
