import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  CHAT_COMMAND_STREAM_PATH,
  CHAT_HISTORY_PATH,
  CHAT_HOOKS_PATH,
  CHAT_READY_PATH,
  CHAT_SHOW_PATH,
  CHAT_STREAM_PATH,
  ChatCommandSseEvents,
  ChatCommandStreamResponse,
  ChatHistoryQuery,
  ChatHistoryResponse,
  ChatHookParams,
  ChatHookPayload,
  ChatHookQuery,
  ChatHookResponse,
  ChatReadyRequest,
  ChatReadyResponse,
  ChatShowRequest,
  ChatShowResponse,
  ChatSseEvents,
  ChatStreamResponse,
  type ChatCommand,
  type ChatEvent,
  type ChatSnapshot,
} from '../../api/server/chats'
import { createSseStream } from '../sse'
import { type WorktreeOpener } from '../worktrees/opener'
import { type ChatRegistry } from './registry'
import { type ChatService } from './service'

export function registerChatRoutes(
  server: FastifyInstance,
  registry: ChatRegistry,
  chat: ChatService,
  opener: WorktreeOpener,
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
          hookMetadata: body._ade_overlay,
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
      operationId: 'liveChats',
      response: {
        200: ChatStreamResponse,
      },
    },
    handler: async (request, reply) => {
      streamChatEvents(request, reply, registry)
    },
  })

  routes.route({
    method: 'POST',
    url: CHAT_SHOW_PATH,
    schema: {
      operationId: 'showChat',
      body: ChatShowRequest,
      response: {
        200: ChatShowResponse,
      },
    },
    handler: async (request) => {
      await opener.openWorktree(request.body.worktreeId, { focus: false })
      opener.focusChat(
        'providerId' in request.body
          ? {
              providerId: request.body.providerId,
              chatId: request.body.chatId,
            }
          : undefined,
      )
      return { ok: true as const }
    },
  })

  routes.route({
    method: 'GET',
    url: CHAT_HISTORY_PATH,
    schema: {
      operationId: 'historicalChats',
      querystring: ChatHistoryQuery,
      response: {
        200: ChatHistoryResponse,
      },
    },
    handler: async (request) => ({
      chats: await chat.listHistory(request.query.worktreeId),
    }),
  })

  routes.route({
    method: 'GET',
    url: CHAT_COMMAND_STREAM_PATH,
    schema: {
      operationId: 'chatCommands',
      response: {
        200: ChatCommandStreamResponse,
      },
    },
    handler: async (request, reply) => {
      streamChatCommands(request, reply, chat)
    },
  })

  // Hidden app-internal endpoint. The spawned chat role calls this only after
  // Electron main is connected to the command stream and the renderer has
  // installed its IPC command handler.
  routes.route({
    method: 'POST',
    url: CHAT_READY_PATH,
    schema: {
      hide: true,
      body: ChatReadyRequest,
      response: {
        200: ChatReadyResponse,
      },
    },
    handler: async (request) => ({
      ok: chat.markReady(request.body.launchId),
    }),
  })
}

function streamChatEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  registry: ChatRegistry,
): void {
  const stream = createSseStream<typeof ChatSseEvents>(request, reply)
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
  const stream = createSseStream<typeof ChatCommandSseEvents>(request, reply)

  const onCommand = (command: ChatCommand): void => {
    stream.send(command.type, command)
  }

  chat.commands.on('command', onCommand)
  stream.onClose(() => {
    chat.commands.off('command', onCommand)
  })
}
