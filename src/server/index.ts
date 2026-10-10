import { Command } from 'commander'
import type { ClientMethods, ServerMethods } from '../shared/api'
import { APP_NAME, RPC_PATH } from '../shared/constants'
import { logger } from '../shared/logger'
import { DEFAULT_SERVER_CONFIG_PATH } from './constants'
import { optionsFromFile } from './options'
import { startRpcServer } from './server'

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
  const options = await optionsFromFile(flags.config)
  const methods: ServerMethods = {
    getServerInfo: () => ({ name: APP_NAME }),
  }
  const server = await startRpcServer<ClientMethods, ServerMethods>(
    methods,
    options,
  )
  log.info(
    { host: options.host, port: server.port, path: RPC_PATH },
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
