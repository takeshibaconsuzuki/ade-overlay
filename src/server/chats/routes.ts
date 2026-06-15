import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { CHAT_HOOKS_PATH, CHAT_STREAM_PATH } from '../../api/server/chats'
import { createSseStream } from '../sse'
import { type ChatRegistry } from './registry'
import {
  ChatHookParams,
  ChatHookPayload,
  ChatHookQuery,
  ChatHookResponse,
  type ChatEvent,
} from './schemas'

export function registerChatRoutes(
  server: FastifyInstance,
  registry: ChatRegistry,
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

  registry.events.on('chat-event', onChatEvent)
  stream.onClose(() => {
    registry.events.off('chat-event', onChatEvent)
  })

  stream.send('snapshot', registry.getSnapshot())
}
