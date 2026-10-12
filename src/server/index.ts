import { Command } from 'commander'
import { dirname, join, resolve } from 'node:path'
import { APP_NAME, RPC_PATH } from '../shared/constants'
import { logger } from '../shared/logger'
import { DEFAULT_SERVER_CONFIG_PATH } from './constants'
import { startServer } from './application'
import { FetchHttpClient } from '../shared/http-client'
import { ProcessVscodeServerManager } from './vscode-manager'
import { NodeVscodeLauncher } from './vscode-process'
import { DownloadedVscodeRuntime } from './vscode-runtime'
import { CodexChatProvider } from './chat-providers/codex/provider'

const log = logger.child({ component: 'server' })

async function main(): Promise<void> {
  const flags = new Command()
    .name(`${APP_NAME}-server`)
    .description('Run the RPC server')
    .option(
      '--config <path>',
      'YAML configuration file; relative paths are resolved from the working directory',
      DEFAULT_SERVER_CONFIG_PATH,
    )
    .parse()
    .opts<{ config: string }>()
  const server = await startServer(
    flags.config,
    new ProcessVscodeServerManager(
      new DownloadedVscodeRuntime(new FetchHttpClient()),
      new NodeVscodeLauncher(),
    ),
    [
      new CodexChatProvider(
        join(
          dirname(resolve(process.argv[1])),
          process.argv[1].endsWith('.ts')
            ? '../../scripts/report-chat.mjs'
            : 'report-chat.mjs',
        ),
      ),
    ],
  )
  log.info(
    { host: server.host, port: server.port, path: RPC_PATH },
    'Server listening',
  )
  const shutdown = () => {
    void server.close().catch((error: unknown) => {
      log.error({ err: error }, 'Server shutdown failed')
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

void main().catch((error: unknown) => {
  log.fatal({ err: error }, 'Server startup failed')
  process.exitCode = 1
})
