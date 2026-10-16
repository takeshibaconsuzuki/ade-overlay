import { Command } from 'commander'
import { dirname, join, resolve } from 'node:path'
import { isSea } from 'node:sea'
import { APP_NAME, RPC_PATH } from '../shared/constants'
import { logger } from '../shared/logger'
import { APP_VERSION } from './constants'
import { resolveServerConfigPath } from './options'
import { startServer } from './application'
import { FetchHttpClient } from '../shared/http-client'
import { ProcessVscodeServerFactory } from './vscode-server'
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
      'YAML configuration file; relative paths are resolved from the working directory (default: ./server.config.yaml, then ~/.ade-overlay/server.config.yaml)',
    )
    .parse()
    .opts<{ config?: string }>()
  log.info({ version: APP_VERSION }, 'Server starting')
  const server = await startServer(
    await resolveServerConfigPath(flags.config),
    new ProcessVscodeServerFactory(
      new DownloadedVscodeRuntime(new FetchHttpClient()),
      new NodeVscodeLauncher(),
    ),
    [
      new CodexChatProvider(
        isSea()
          ? [process.execPath, '--report-chat']
          : [
              process.execPath,
              join(
                dirname(resolve(process.argv[1])),
                process.argv[1].endsWith('.ts')
                  ? '../../scripts/report-chat.mjs'
                  : 'report-chat.mjs',
              ),
            ],
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
