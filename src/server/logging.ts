import { homedir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'

export const serverLogPath = join(homedir(), '.ade-overlay', 'server.log')

export function createServerLogger() {
  const file = pino.destination({
    dest: serverLogPath,
    mkdir: true,
    sync: true,
  })
  const logger = pino(
    {
      name: 'ade-companion',
      level: process.env.ADE_LOG_LEVEL ?? 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: [
        'token',
        'accessToken',
        'headers.authorization',
        'headers.cookie',
        'session.accessToken',
      ],
    },
    pino.multistream([
      { level: 'trace', stream: process.stdout },
      { level: 'trace', stream: file },
    ]),
  )
  return { logger, close: () => file.end() }
}

export const silentLogger = pino({ level: 'silent' })
