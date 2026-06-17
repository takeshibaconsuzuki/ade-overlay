import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { type Duplex } from 'node:stream'
import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { SERVER_PORT } from '../../api/server/config'
import {
  EDITOR_BASE_PATH,
  EDITOR_BOOTSTRAP_PATH,
  EDITOR_COMMAND_ACK_PATH,
  EDITOR_SESSION_STATUS_EVENT,
  type EditorCommand,
  type EditorSessionStatus,
} from '../../api/server/editor'
import { HttpError } from '../errors'
import { createSseStream } from '../sse'
import { type WorktreeOpener } from '../worktrees/opener'
import { type WorktreeRegistry } from '../worktrees/registry'
import { WorktreeIdParams } from '../worktrees/schemas'
import {
  EditorCommandAckRequest,
  EditorCommandAckResponse,
  ErrorResponse,
  OpenCodeRequest,
  OpenCodeResponse,
  OpenCreationLogsResponse,
  OpenWorktreeRequest,
  OpenWorktreeResponse,
} from './schemas'
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
    url: '/editorCommands',
    schema: {
      operationId: 'editorCommands',
      response: {
        200: z.string().describe('Server-sent editor switch commands.'),
      },
    },
    handler: async (request, reply) => {
      streamEditorCommands(request, reply, editor)
    },
  })

  routes.route({
    method: 'GET',
    url: '/editorSessions',
    schema: {
      operationId: 'editorSessions',
      response: {
        200: z.string().describe('Server-sent editor session status events.'),
      },
    },
    handler: async (request, reply) => {
      streamEditorSessions(request, reply, editor)
    },
  })

  routes.route({
    method: 'GET',
    url: '/editorExtensionCommands',
    schema: {
      hide: true,
      querystring: z.object({ worktreeId: z.string() }),
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
    url: '/openCode',
    schema: {
      operationId: 'openCode',
      body: OpenCodeRequest,
      response: {
        200: OpenCodeResponse,
        404: ErrorResponse,
        500: ErrorResponse,
      },
    },
    handler: async (request) => {
      const response = await editor.openCode(request.body.worktreeId)
      editor.showEditor()
      return response
    },
  })

  routes.route({
    method: 'POST',
    url: '/showEditor',
    schema: {
      operationId: 'showEditor',
      body: OpenCodeRequest,
      response: {
        200: OpenCodeResponse,
        404: ErrorResponse,
        500: ErrorResponse,
      },
    },
    // Bring the editor forward on a worktree without selecting it — focuses the
    // window without changing the worktree the user is in.
    handler: async (request) => {
      const response = await editor.revealEditor(request.body.worktreeId)
      editor.showEditor()
      return response
    },
  })

  routes.route({
    method: 'POST',
    url: '/openWorktree',
    schema: {
      operationId: 'openWorktree',
      body: OpenWorktreeRequest,
      response: {
        200: OpenWorktreeResponse,
        404: ErrorResponse,
        500: ErrorResponse,
      },
    },
    handler: async (request) => opener.openWorktree(request.body.worktreeId),
  })

  routes.route({
    method: 'POST',
    url: '/worktrees/:worktreeId/creation-logs/open',
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
      await editor.openFile(mainWorktreeId, job.logPath)
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

  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port,
      method: request.raw.method,
      path: request.raw.url,
      headers,
    },
    (upstreamResponse) => {
      reply.raw.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      )
      upstreamResponse.pipe(reply.raw)
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
  const stream = createSseStream(request, reply)
  const unregisterClient = editor.registerEditorClient()

  const onCommand = (command: EditorCommand): void => {
    stream.send(command.type, command)
  }

  editor.commands.on('command', onCommand)
  stream.onClose(() => {
    unregisterClient()
    editor.commands.off('command', onCommand)
  })

  for (const command of editor.getReplayCommands()) {
    stream.send(command.type, command)
  }
}

function streamEditorExtensionCommands(
  request: FastifyRequest,
  reply: FastifyReply,
  editor: EditorService,
  worktreeId: string,
): void {
  const stream = createSseStream(request, reply)

  const onCommand = (command: EditorCommand): void => {
    if (command.type === 'open-file' && command.worktreeId === worktreeId) {
      stream.send('open-file', { filePath: command.filePath })
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
    stream.send('open-file', { filePath: lastFilePath })
  }
}

function streamEditorSessions(
  request: FastifyRequest,
  reply: FastifyReply,
  editor: EditorService,
): void {
  const stream = createSseStream(request, reply)

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
