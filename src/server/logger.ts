import pino, { type Logger } from 'pino'
import { createLogShippingStream, flushLogShipper } from './logShipper'

const isProduction = process.env.NODE_ENV === 'production'

/**
 * Set by spawned Node processes that don't share the server's stdout (the
 * editor Electron process). When present, logs are shipped to the server's
 * `POST /logs` endpoint — tagged with this value as their `source` — instead of
 * being written locally, keeping all Electron logging in one stream.
 */
const remoteSource = process.env.ADE_LOG_SOURCE

const level = process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug')

/**
 * Shared Pino logger for all Node-side application code — the Electron main
 * process and the Fastify server. Fastify is constructed with this instance
 * (`loggerInstance`), so framework request logs and application logs share a
 * single stream, format, and level. Services add context via `logger.child()`.
 *
 * In the server/controller process this pretty-prints in development and emits
 * JSON in production. In a remote process (see `remoteSource`) it instead ships
 * records over HTTP. Override the level with the `LOG_LEVEL` environment
 * variable.
 */
export const logger: Logger = remoteSource
  ? pino({ level }, createLogShippingStream(remoteSource))
  : pino({
      level,
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

/**
 * Drains any buffered remote log records. A no-op outside remote processes.
 * Call before the process exits so the final records are not lost.
 */
export async function flushLogs(): Promise<void> {
  if (remoteSource) {
    await flushLogShipper()
  }
}
