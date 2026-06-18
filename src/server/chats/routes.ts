import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import { WebSocketServer } from 'ws'
import { z } from 'zod/v4'
import {
  CHAT_COMMAND_STREAM_PATH,
  CHAT_HISTORY_PATH,
  CHAT_HOOKS_PATH,
  CHAT_OPEN_PATH,
  CHAT_STREAM_PATH,
  CHAT_TERMINALS_PATH,
  type ChatCommand,
} from '../../api/server/chats'
import { createSseStream } from '../sse'
import { type ChatRegistry } from './registry'
import {
  ChatHistoryQuery,
  ChatHistoryResponse,
  ChatHookParams,
  ChatHookPayload,
  ChatHookQuery,
  ChatHookResponse,
  ChatOpenRequest,
  ChatOpenResponse,
  ChatTerminal,
  ChatTerminalCreateRequest,
  ChatTerminalListQuery,
  ChatTerminalListResponse,
  type ChatEvent,
  type ChatSnapshot,
} from './schemas'
import { type ChatService } from './service'

export function registerChatRoutes(
  server: FastifyInstance,
  registry: ChatRegistry,
  chat: ChatService,
): void {
  const routes = server.withTypeProvider<ZodTypeProvider>()

  // Hook sink for agentic coding systems. Hidden from the OpenAPI document and
  // generated client: it is called by external processes, not the renderer.
  routes.route({
    method: 'POST',
    url: `${CHAT_HOOKS_PATH}/:providerId`,
    schema: {
      hide: true,
      params: ChatHookParams,
      querystring: ChatHookQuery,
      body: ChatHookPayload,
      response: {
        200: ChatHookResponse,
      },
    },
    handler: async (request) => {
      const body = request.body as Record<string, unknown>
      // Log the raw event name so we can see every hook the agent fires —
      // including ones we don't map to a status (those never reach the
      // registry's own logging). Useful for diagnosing unexpected status flips
      // (e.g. background recap/away-summary generation).
      request.log.debug(
        {
          providerId: request.params.providerId,
          event: body.hook_event_name,
          worktreeId: request.query.worktreeId,
        },
        'chat hook received',
      )
      registry.applyHook(request.params.providerId, body, {
        worktreeId: request.query.worktreeId,
      })
      return { ok: true as const }
    },
  })

  routes.route({
    method: 'GET',
    url: CHAT_STREAM_PATH,
    schema: {
      operationId: 'listChats',
      response: {
        200: z.string().describe('Server-sent live chat snapshot and events.'),
      },
    },
    handler: async (request, reply) => {
      streamChatEvents(request, reply, registry)
    },
  })

  routes.route({
    method: 'POST',
    url: CHAT_OPEN_PATH,
    schema: {
      operationId: 'openChat',
      body: ChatOpenRequest,
      response: {
        200: ChatOpenResponse,
      },
    },
    handler: async (request) => {
      chat.openChat()
      chat.focusChat(request.body)
      return { ok: true as const }
    },
  })

  routes.route({
    method: 'GET',
    url: CHAT_HISTORY_PATH,
    schema: {
      operationId: 'listChatHistory',
      querystring: ChatHistoryQuery,
      response: {
        200: ChatHistoryResponse,
      },
    },
    handler: async (request) => ({
      sessions: await chat.listSessions(request.query.worktreeId),
    }),
  })

  routes.route({
    method: 'GET',
    url: CHAT_TERMINALS_PATH,
    schema: {
      operationId: 'listChatTerminals',
      querystring: ChatTerminalListQuery,
      response: {
        200: ChatTerminalListResponse,
      },
    },
    handler: async (request) => ({
      terminals: chat.listTerminals(request.query.worktreeId),
    }),
  })

  routes.route({
    method: 'POST',
    url: CHAT_TERMINALS_PATH,
    schema: {
      operationId: 'createChatTerminal',
      body: ChatTerminalCreateRequest,
      response: {
        200: ChatTerminal,
      },
    },
    handler: async (request) =>
      chat.createTerminal({
        worktreeId: request.body.worktreeId,
        providerId: request.body.providerId,
        resumeSessionId: request.body.resumeSessionId,
        title: request.body.title,
      }),
  })

  routes.route({
    method: 'GET',
    url: CHAT_COMMAND_STREAM_PATH,
    schema: {
      operationId: 'chatCommands',
      response: {
        200: z.string().describe('Server-sent chat window commands.'),
      },
    },
    handler: async (request, reply) => {
      streamChatCommands(request, reply, chat)
    },
  })

  registerTerminalSocket(server, chat)
}

function streamChatEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  registry: ChatRegistry,
): void {
  const stream = createSseStream(request, reply)
  const onChatEvent = (event: ChatEvent): void => {
    stream.send(event.type, event)
  }
  // A terminal change re-broadcasts the full snapshot (no single chat changed).
  const onSnapshot = (snapshot: ChatSnapshot): void => {
    stream.send('snapshot', snapshot)
  }

  registry.events.on('chat-event', onChatEvent)
  registry.events.on('chat-snapshot', onSnapshot)
  stream.onClose(() => {
    registry.events.off('chat-event', onChatEvent)
    registry.events.off('chat-snapshot', onSnapshot)
  })

  stream.send('snapshot', registry.getSnapshot())
}

function streamChatCommands(
  request: FastifyRequest,
  reply: FastifyReply,
  chat: ChatService,
): void {
  const stream = createSseStream(request, reply)
  const unregisterClient = chat.registerChatClient()

  const onCommand = (command: ChatCommand): void => {
    stream.send(command.type, command)
  }

  chat.commands.on('command', onCommand)
  stream.onClose(() => {
    unregisterClient()
    chat.commands.off('command', onCommand)
  })

  // Replay the last command so an app that connects right after being spawned
  // still receives the `show` that triggered its launch.
  const lastCommand = chat.getLastCommand()
  if (lastCommand) {
    stream.send(lastCommand.type, lastCommand)
  }
}

/**
 * Attach a terminal WebSocket by hand on the raw server `upgrade` event, the
 * same way the editor proxies its sockets. Using `noServer` mode keeps us off
 * Fastify's router and avoids fighting the editor's existing upgrade handler:
 * each handler only claims the upgrades whose URL it recognizes.
 */
function registerTerminalSocket(
  server: FastifyInstance,
  chat: ChatService,
): void {
  const wss = new WebSocketServer({ noServer: true })

  server.server.on('upgrade', (request, socket, head) => {
    const terminalId = terminalIdFromUrl(request.url)
    if (!terminalId) {
      return
    }
    const viewerId = viewerIdFromUrl(request.url)
    wss.handleUpgrade(request, socket, head, (ws) => {
      chat.attachTerminal(terminalId, ws, viewerId)
    })
  })

  server.addHook('onClose', async () => {
    wss.close()
  })
}

/**
 * Extract the terminal id from a `/chats/terminals/<id>/socket` upgrade URL, or
 * null when the path is not a chat terminal socket (so other upgrade handlers,
 * notably the editor proxy, get their turn).
 */
function terminalIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null
  }
  let pathname: string
  try {
    pathname = new URL(url, 'http://localhost').pathname
  } catch {
    return null
  }
  const prefix = `${CHAT_TERMINALS_PATH}/`
  const suffix = '/socket'
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null
  }
  const id = pathname.slice(prefix.length, -suffix.length)
  return id.length > 0 && !id.includes('/') ? decodeURIComponent(id) : null
}

/**
 * Read the renderer's `viewer` query param off a terminal socket upgrade URL.
 * The renderer stamps a per-mount id there so server-side socket logs can be
 * joined to the exact `Terminal` component instance that opened the connection —
 * the only way to tell one reconnecting viewer from two dueling ones.
 */
function viewerIdFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined
  }
  try {
    return new URL(url, 'http://localhost').searchParams.get('viewer') ?? undefined
  } catch {
    return undefined
  }
}
