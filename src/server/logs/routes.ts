import { type FastifyInstance } from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  IngestLogsRequest,
  IngestLogsResponse,
  LOGS_PATH,
} from '../../api/server/logs'

/**
 * Ingests log records shipped by non-server processes (the renderer and the
 * editor Electron process) and re-emits them through the server logger, so all
 * logs are consolidated in one stream. Each record is tagged with its reported
 * `source` (defaulting to `renderer`) to distinguish it from server logs.
 */
export function registerLogRoutes(server: FastifyInstance): void {
  const log = server.log.child({ source: 'logs' })
  const routes = server.withTypeProvider<ZodTypeProvider>()

  routes.route({
    method: 'POST',
    url: LOGS_PATH,
    // Silence Fastify's automatic request/response logging for this route: each
    // batch POST would otherwise add noise that doesn't correspond 1:1 with the
    // client entries we re-emit below. This only affects the request-scoped
    // logger, not the instance child logger used in the handler.
    logLevel: 'silent',
    // `logLevel: 'silent'` also suppresses Fastify's route-level error logging,
    // so restore visibility explicitly via the instance logger. This fires for
    // both handler errors and schema-validation failures (a malformed batch).
    onError: async (_request, _reply, error) => {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500
      const level = statusCode >= 500 ? 'error' : 'warn'
      log[level]({ err: error }, 'failed to ingest client logs')
    },
    schema: {
      operationId: 'ingestLogs',
      body: IngestLogsRequest,
      response: {
        200: IngestLogsResponse,
      },
    },
    handler: async (request) => {
      const { records } = request.body
      for (const record of records) {
        server.log[record.level](
          {
            source: record.source ?? 'renderer',
            ...record.bindings,
            ...record.fields,
            clientTime: record.time,
          },
          record.msg ?? '',
        )
      }
      return { received: records.length }
    },
  })
}
