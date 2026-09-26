import { DEFAULT_COMPANION_PORT } from '../shared/companion.ts'
import { startCompanionServer } from './server.ts'
import { parseServerArgs } from './config.ts'
import { createServerLogger, serverLogPath } from './logging.ts'

const logging = createServerLogger()

async function main(): Promise<void> {
  const args = parseServerArgs(process.argv.slice(2))
  const rawPort =
    process.env.ADE_COMPANION_PORT ?? String(DEFAULT_COMPANION_PORT)
  const port = Number(rawPort)
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      'ADE_COMPANION_PORT must be an integer between 1 and 65535.',
    )
  }
  const server = await startCompanionServer({
    ...args,
    host: process.env.ADE_COMPANION_HOST ?? '127.0.0.1',
    port,
    token: process.env.ADE_COMPANION_TOKEN || undefined,
    logger: logging.logger,
  })
  server.startEditorUpdates()
  logging.logger.info(
    { url: server.url, logFile: serverLogPath },
    'Companion ready. Press Ctrl+C to stop.',
  )

  const shutdown = (): void => {
    logging.logger.info('Stopping companion')
    void server
      .close()
      .then(() => logging.logger.info('Companion stopped'))
      .catch((error: unknown) => {
        logging.logger.error({ err: error }, 'Failed to stop companion')
        process.exitCode = 1
      })
      .finally(() => logging.close())
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  logging.logger.error({ err: error }, 'Could not start companion server')
  logging.close()
  process.exitCode = 1
})
