import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { type Duplex } from 'node:stream'
import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import { SERVER_PORT } from '../../api/server/config'
import {
  EDITOR_BASE_PATH,
  EDITOR_BOOTSTRAP_PATH,
  EDITOR_COMMAND_ACK_PATH,
  EDITOR_COMMAND_STREAM_PATH,
  EDITOR_EXTENSION_COMMAND_STREAM_PATH,
  EDITOR_EXTENSION_OPEN_FILE_EVENT,
  EDITOR_READY_PATH,
  EDITOR_SESSION_STATUS_EVENT,
  EDITOR_SESSION_STREAM_PATH,
  EDITOR_SHOW_PATH,
  EditorCommandAckRequest,
  EditorCommandAckResponse,
  EditorCommandSseEvents,
  EditorCommandStreamResponse,
  EditorExtensionCommandQuery,
  EditorExtensionCommandSseEvents,
  EditorReadyRequest,
  EditorReadyResponse,
  EditorSessionSseEvents,
  EditorSessionStreamResponse,
  EditorWorktreeRequest,
  EditorWorktreeResponse,
  ErrorResponse,
  OpenCreationLogsResponse,
  StopVscodeServerResponse,
  VSCODE_SERVER_STOP_PATH,
  type EditorCommand,
  type EditorExtensionOpenFileCommand,
  type EditorSessionStatus,
} from '../../api/server/editor'
import {
  WORKTREE_CREATION_LOGS_OPEN_PATH,
  WorktreeIdParams,
} from '../../api/server/worktrees'
import { HttpError } from '../errors'
import { createSseStream } from '../sse'
import { type WorktreeOpener } from '../worktrees/opener'
import { type WorktreeRegistry } from '../worktrees/registry'
import { EditorService } from './service'

type EditorRouteOptions = {
  registry: WorktreeRegistry
  editor: EditorService
  opener: WorktreeOpener
}

export function registerEditorRoutes(
  server: FastifyInstance,
  { registry, editor, opener }: EditorRouteOptions,
): void {
  registerEditorProxy(server, editor)
  const routes = server.withTypeProvider<ZodTypeProvider>()

  routes.route({
    method: 'GET',
    url: EDITOR_COMMAND_STREAM_PATH,
    schema: {
      operationId: 'editorCommands',
      response: {
        200: EditorCommandStreamResponse,
      },
    },
    handler: async (request, reply) => {
      streamEditorCommands(request, reply, editor)
    },
  })

  routes.route({
    method: 'GET',
    url: EDITOR_SESSION_STREAM_PATH,
    schema: {
      operationId: 'editorSessions',
      response: {
        200: EditorSessionStreamResponse,
      },
    },
    handler: async (request, reply) => {
      streamEditorSessions(request, reply, editor)
    },
  })

  routes.route({
    method: 'GET',
    url: EDITOR_EXTENSION_COMMAND_STREAM_PATH,
    schema: {
      hide: true,
      querystring: EditorExtensionCommandQuery,
    },
    handler: async (request, reply) => {
      streamEditorExtensionCommands(
        request,
        reply,
        editor,
        request.query.worktreeId,
      )
    },
  })

  routes.route({
    method: 'POST',
    url: EDITOR_SHOW_PATH,
    schema: {
      operationId: 'showEditor',
      body: EditorWorktreeRequest,
      response: {
        200: EditorWorktreeResponse,
        404: ErrorResponse,
        500: ErrorResponse,
      },
    },
    // Open the worktree through the shared opener so editor/chat visibility is
    // consistent with /showChat, then make the editor the foreground app.
    handler: async (request) => {
      const response = await opener.openWorktree(request.body.worktreeId, {
        focus: false,
      })
      editor.focusEditor()
      return {
        worktreeId: response.worktreeId,
        url: response.url,
        alreadyStarted: response.editorAlreadyStarted,
      }
    },
  })

  routes.route({
    method: 'POST',
    url: WORKTREE_CREATION_LOGS_OPEN_PATH,
    schema: {
      operationId: 'openCreationLogs',
      params: WorktreeIdParams,
      response: {
        200: OpenCreationLogsResponse,
        404: ErrorResponse,
        500: ErrorResponse,
      },
    },
    handler: async (request) => {
      const job = registry.getCreationJob(request.params.worktreeId)
      if (!job) {
        throw new HttpError(
          404,
          `No creation logs for worktree: ${request.params.worktreeId}`,
        )
      }
      const mainWorktreeId = await registry.resolveMainWorktreeId(
        job.mainWorktreePath,
      )
      await opener.openWorktree(mainWorktreeId, { focus: false })
      await editor.openFile(mainWorktreeId, job.logPath)
      editor.focusEditor()
      return { ok: true as const }
    },
  })

  routes.route({
    method: 'POST',
    url: VSCODE_SERVER_STOP_PATH,
    schema: {
      operationId: 'stopVscodeServer',
      params: WorktreeIdParams,
      response: {
        200: StopVscodeServerResponse,
        404: ErrorResponse,
        500: ErrorResponse,
      },
    },
    handler: async (request) => {
      await editor.stopVscodeServer(request.params.worktreeId)
      return { ok: true as const }
    },
  })

  routes.route({
    method: 'POST',
    url: EDITOR_COMMAND_ACK_PATH,
    schema: {
      hide: true,
      body: EditorCommandAckRequest,
      response: {
        200: EditorCommandAckResponse,
      },
    },
    handler: async (request) => {
      editor.ackEditorCommand(request.body.commandId)
      return { ok: true as const }
    },
  })

  // Hidden app-internal endpoint. The spawned editor role calls this only after
  // Electron main is connected to the command stream.
  routes.route({
    method: 'POST',
    url: EDITOR_READY_PATH,
    schema: {
      hide: true,
      body: EditorReadyRequest,
      response: {
        200: EditorReadyResponse,
      },
    },
    handler: async (request) => ({
      ok: editor.markReady(request.body.launchId),
    }),
  })
}

function registerEditorProxy(
  server: FastifyInstance,
  editor: EditorService,
): void {
  server.route({
    method: ['GET', 'HEAD'],
    url: EDITOR_BOOTSTRAP_PATH,
    schema: { hide: true },
    handler: async (request, reply) => {
      const worktreeId = getWorktreeIdFromHost(request.headers.host)
      if (!worktreeId) {
        reply.callNotFound()
        return
      }

      reply
        .type('text/html; charset=utf-8')
        .send(await editor.getBootstrapHtml(worktreeId))
    },
  })

  for (const url of [EDITOR_BASE_PATH, `${EDITOR_BASE_PATH}/*`]) {
    server.route({
      method: ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'],
      url,
      schema: { hide: true },
      handler: async (request, reply) => {
        await proxyWorktreeRequest(request, reply, editor)
      },
    })
  }

  server.server.on('upgrade', (request, socket, head) => {
    const worktreeId = getWorktreeIdFromHost(request.headers.host)
    if (!worktreeId || !isEditorProxyPath(request.url)) {
      return
    }

    socket.pause()
    void editor
      .getProxyPort(worktreeId)
      .then((port) => proxyWebSocket(request, socket, head, port))
      .catch(() => socket.destroy())
  })
}

async function proxyWorktreeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  editor: EditorService,
): Promise<void> {
  const worktreeId = getWorktreeIdFromHost(request.headers.host)
  if (!worktreeId) {
    reply.callNotFound()
    return
  }

  reply.hijack()
  try {
    const port = await editor.getProxyPort(worktreeId)
    proxyHttpRequest(request, reply, port)
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 502
    const message =
      error instanceof Error ? error.message : 'Editor proxy error'
    reply.raw.writeHead(statusCode, {
      'content-type': 'text/plain; charset=utf-8',
    })
    reply.raw.end(message)
  }
}

// VS Code `serve-web` renders status pages (e.g. its "Upgrading…" notice) whose
// text inherits the document color. Against our dark editor background that text
// is unreadable, so we force inherited text white on proxied HTML documents.
const EDITOR_TEXT_STYLE =
  '<style>/* ADE: keep serve-web status text (e.g. "Upgrading…") legible */body{color:white!important}</style>'

function injectEditorStyles(html: string): string {
  const headCloseIndex = html.indexOf('</head>')
  if (headCloseIndex === -1) {
    return EDITOR_TEXT_STYLE + html
  }
  return (
    html.slice(0, headCloseIndex) +
    EDITOR_TEXT_STYLE +
    html.slice(headCloseIndex)
  )
}

function proxyHttpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  port: number,
): void {
  const headers = { ...request.headers }
  delete headers.connection
  delete headers['proxy-connection']
  delete headers['keep-alive']
  delete headers['transfer-encoding']
  delete headers.upgrade
  // Ask upstream for an uncompressed body so we can inject styles into HTML.
  delete headers['accept-encoding']

  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port,
      method: request.raw.method,
      path: request.raw.url,
      headers,
    },
    (upstreamResponse) => {
      const isHtmlDocument =
        request.raw.method === 'GET' &&
        (upstreamResponse.headers['content-type'] ?? '')
          .toLowerCase()
          .includes('text/html')
      if (!isHtmlDocument) {
        reply.raw.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          upstreamResponse.headers,
        )
        upstreamResponse.pipe(reply.raw)
        return
      }

      // Buffer the HTML so we can inject our stylesheet and restate its length.
      const chunks: Buffer[] = []
      upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk))
      upstreamResponse.on('error', () => reply.raw.destroy())
      upstreamResponse.on('end', () => {
        const body = Buffer.from(
          injectEditorStyles(Buffer.concat(chunks).toString('utf8')),
          'utf8',
        )
        const responseHeaders = { ...upstreamResponse.headers }
        delete responseHeaders['content-encoding']
        delete responseHeaders['transfer-encoding']
        responseHeaders['content-length'] = String(body.byteLength)
        reply.raw.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          responseHeaders,
        )
        reply.raw.end(body)
      })
    },
  )

  upstream.on('error', (error) => {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    reply.raw.end(`Editor proxy error: ${error.message}`)
  })

  request.raw.pipe(upstream)
}

function proxyWebSocket(
  request: FastifyRequest['raw'],
  socket: Duplex,
  head: Buffer,
  port: number,
): void {
  const upstream = createConnection({ host: '127.0.0.1', port }, () => {
    upstream.write(
      `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${
        request.httpVersion
      }\r\n`,
    )
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      upstream.write(
        `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`,
      )
    }
    upstream.write('\r\n')
    if (head.length > 0) {
      upstream.write(head)
    }
    socket.resume()
    socket.pipe(upstream)
    upstream.pipe(socket)
  })

  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}

function getWorktreeIdFromHost(host?: string): string | null {
  if (!host) {
    return null
  }
  const hostname = host.split(':')[0]
  const suffix = '.localhost'
  if (!hostname.endsWith(suffix)) {
    return null
  }
  const worktreeId = hostname.slice(0, -suffix.length)
  return /^[a-z0-9]+$/.test(worktreeId) ? worktreeId : null
}

function isEditorProxyPath(url?: string): boolean {
  if (!url) {
    return false
  }
  try {
    const { pathname } = new URL(url, 'http://localhost')
    return (
      pathname === EDITOR_BASE_PATH ||
      pathname.startsWith(`${EDITOR_BASE_PATH}/`)
    )
  } catch {
    return false
  }
}

function streamEditorCommands(
  request: FastifyRequest,
  reply: FastifyReply,
  editor: EditorService,
): void {
  const stream = createSseStream<typeof EditorCommandSseEvents>(request, reply)
  const unregisterClient = editor.registerEditorClient()

  const onCommand = (command: EditorCommand): void => {
    stream.send(command.type, command)
  }

  editor.commands.on('command', onCommand)
  stream.onClose(() => {
    unregisterClient()
    editor.commands.off('command', onCommand)
  })
}

function streamEditorExtensionCommands(
  request: FastifyRequest,
  reply: FastifyReply,
  editor: EditorService,
  worktreeId: string,
): void {
  const stream = createSseStream<typeof EditorExtensionCommandSseEvents>(
    request,
    reply,
  )

  const onCommand = (command: EditorCommand): void => {
    if (command.type === 'open-file' && command.worktreeId === worktreeId) {
      const payload: EditorExtensionOpenFileCommand = {
        filePath: command.filePath,
      }
      stream.send(EDITOR_EXTENSION_OPEN_FILE_EVENT, payload)
    }
  }

  editor.commands.on('command', onCommand)
  stream.onClose(() => {
    editor.commands.off('command', onCommand)
  })

  // Replay the last requested file so a freshly booted session (whose extension
  // connects after the command was emitted) still opens it.
  const lastFilePath = editor.getLastOpenFile(worktreeId)
  if (lastFilePath) {
    const payload: EditorExtensionOpenFileCommand = { filePath: lastFilePath }
    stream.send(EDITOR_EXTENSION_OPEN_FILE_EVENT, payload)
  }
}

function streamEditorSessions(
  request: FastifyRequest,
  reply: FastifyReply,
  editor: EditorService,
): void {
  const stream = createSseStream<typeof EditorSessionSseEvents>(request, reply)

  const onStatus = (status: EditorSessionStatus): void => {
    stream.send(EDITOR_SESSION_STATUS_EVENT, status)
  }

  editor.sessionStatusEvents.on(EDITOR_SESSION_STATUS_EVENT, onStatus)
  stream.onClose(() => {
    editor.sessionStatusEvents.off(EDITOR_SESSION_STATUS_EVENT, onStatus)
  })

  stream.send('snapshot', editor.getSessionStatuses())
}

export function editorHostFor(worktreeId: string): string {
  return `${worktreeId}.localhost:${SERVER_PORT}`
}
