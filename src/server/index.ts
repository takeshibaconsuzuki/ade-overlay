import { DEFAULT_COMPANION_PORT } from '../shared/companion.ts'
import { startCompanionServer } from './server.ts'
import { parseServerArgs } from './config.ts'
import { createServerLogger, serverLogPath } from './logging.ts'
import { installChatHooks } from './chat-hooks.ts'
import { readFile } from 'node:fs/promises'
import { installBundledExtension } from './install-extension.ts'

let logging: ReturnType<typeof createServerLogger> | undefined

async function main(): Promise<void> {
  const args = parseServerArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'Usage: ade-companion [--config path/to/server.yaml]\n       ade-companion --install-extension [--config path/to/server.yaml]\n       ade-companion --version\n\nConfiguration defaults to ~/.ade-overlay/server.yaml.\nKeep this installation at a stable path for provider hooks.\nInstall VS Code separately; running editors accepts https://aka.ms/vscode-server-license.',
    )
    return
  }
  if (args.version) {
    const manifest = new URL(
      import.meta.url.endsWith('.ts')
        ? '../../package.json'
        : '../package.json',
      import.meta.url,
    )
    console.log(JSON.parse(await readFile(manifest, 'utf8')).version)
    return
  }
  if (args.installExtension) {
    await installBundledExtension(args.configPath)
    return
  }
  const serverLogging = createServerLogger()
  logging = serverLogging
  await installChatHooks()
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
    logger: serverLogging.logger,
  })
  server.startEditorUpdates()
  serverLogging.logger.info(
    { url: server.url, logFile: serverLogPath },
    'Companion ready. Press Ctrl+C to stop.',
  )

  const shutdown = (): void => {
    serverLogging.logger.info('Stopping companion')
    void server
      .close()
      .then(() => serverLogging.logger.info('Companion stopped'))
      .catch((error: unknown) => {
        serverLogging.logger.error({ err: error }, 'Failed to stop companion')
        process.exitCode = 1
      })
      .finally(() => serverLogging.close())
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  if (logging) {
    logging.logger.error({ err: error }, 'Could not start companion server')
    logging.close()
  } else console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
