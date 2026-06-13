import pino, { type Logger } from 'pino'

const isProduction = process.env.NODE_ENV === 'production'

/**
 * Shared Pino logger for all Node-side application code — the Electron main
 * process and the Fastify server. Fastify is constructed with this instance
 * (`loggerInstance`), so framework request logs and application logs share a
 * single stream, format, and level. Services add context via `logger.child()`.
 *
 * Pretty-prints in development and emits JSON in production. Override the level
 * with the `LOG_LEVEL` environment variable.
 */
export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
})
