import { type FastifyInstance } from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  APP_FOCUS_EVENT,
  APP_FOCUS_PATH,
  AppFocusRequest,
  AppFocusResponse,
} from '../../api/server/appFocus'
import { type AppFocusService } from './service'

export function registerAppFocusRoutes(
  server: FastifyInstance,
  focus: AppFocusService,
): void {
  const routes = server.withTypeProvider<ZodTypeProvider>()

  routes.route({
    method: 'POST',
    url: APP_FOCUS_PATH,
    schema: {
      hide: true,
      body: AppFocusRequest,
      response: {
        200: AppFocusResponse,
      },
    },
    handler: async (request) => {
      if (request.body.event === APP_FOCUS_EVENT.focused) {
        focus.recordFocused(request.body.role)
      } else {
        focus.recordClosed(request.body.role)
      }
      return { ok: true as const }
    },
  })
}
