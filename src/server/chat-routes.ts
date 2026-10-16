import type { FastifyPluginAsync } from 'fastify'
import { ZodError } from 'zod'
import { UnknownChatProviderError } from './chat-provider'
import type { ChatStore } from './chat-store'
import { CHAT_REPORT_PATH } from './constants'

export const chatRoutes: FastifyPluginAsync<{ chats: ChatStore }> = async (
  app,
  { chats },
) => {
  app.post<{ Params: { provider: string }; Body: unknown }>(
    `${CHAT_REPORT_PATH}/:provider`,
    async (request, reply) => {
      request.log = request.log.child({ providerId: request.params.provider })
      try {
        await chats.report(request.params.provider, request.body)
      } catch (error) {
        if (
          error instanceof ZodError ||
          error instanceof UnknownChatProviderError
        ) {
          request.log.warn({ err: error }, 'Invalid chat report')
          return reply.code(400).send({ message: 'Invalid chat report' })
        }
        throw error
      }
      return reply.code(204).send()
    },
  )
}
