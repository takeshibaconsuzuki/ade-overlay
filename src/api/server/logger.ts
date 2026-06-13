/**
 * Shared logging contract for server API logging. Lives in `src/api/server`
 * (node-free) so every layer can depend on the interface rather than a concrete
 * logger, allowing different implementations per environment: Pino on the
 * server, Pino's browser build in the renderer (which also ships records to the
 * server over HTTP). Pino and Fastify's `FastifyBaseLogger` are structurally
 * assignable to `Logger`.
 */

export const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export type LogFields = Record<string, unknown>

interface LogFn {
  (fields: LogFields, message: string): void
  (message: string): void
}

export interface Logger {
  trace: LogFn
  debug: LogFn
  info: LogFn
  warn: LogFn
  error: LogFn
  fatal: LogFn
  child(bindings: LogFields): Logger
}
