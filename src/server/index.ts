import { DEFAULT_COMPANION_PORT } from '../shared/companion.ts'
import { startCompanionServer } from './server.ts'

async function main(): Promise<void> {
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
    host: process.env.ADE_COMPANION_HOST ?? '127.0.0.1',
    port,
    token: process.env.ADE_COMPANION_TOKEN || undefined,
  })
  console.log(`ADE companion listening at ${server.url}`)
  console.log('Press Ctrl+C to stop.')

  const shutdown = (): void => {
    void server.close().catch((error: unknown) => {
      console.error('Failed to stop companion server:', error)
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  console.error(
    'Could not start companion server:',
    error instanceof Error ? error.message : error,
  )
  process.exitCode = 1
})
