import type { FastifyPluginAsync } from 'fastify'
import { ZodError } from 'zod'
import { UnknownChatProviderError } from './chat-provider'
import type { ChatStore } from './chat-store'

export const chatRoutes: FastifyPluginAsync<{ chats: ChatStore }> = async (
  app,
  { chats },
) => {
  app.post<{ Params: { provider: string }; Body: unknown }>(
    '/chats/report/:provider',
    async (request, reply) => {
      try {
        await chats.report(request.params.provider, request.body)
      } catch (error) {
        if (
          error instanceof ZodError ||
          error instanceof UnknownChatProviderError
        )
          return reply.code(400).send({ message: 'Invalid chat report' })
        throw error
      }
      return reply.code(204).send()
    },
  )
}
