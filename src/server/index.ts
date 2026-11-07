import { Command } from 'commander'
import envPaths from 'env-paths'
import { mkdir } from 'node:fs/promises'
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
import { ClaudeChatProvider } from './chat-providers/claude/provider'
import type { ChatProvider } from './chat-provider'
import { ChatHistory, ChatHistoryIndex } from './chat-history'
import { ProcessChatHistoryIndexer } from './chat-history-process'

const log = logger.child({ component: 'server' })
// Usage: <server> --index-chat-history <database>. Updates the index once, then exits.
const INDEX_CHAT_HISTORY = '--index-chat-history'

// This program's own command line, without arguments.
function selfCommand(): [string, ...string[]] {
  return isSea()
    ? [process.execPath]
    : [process.execPath, ...process.execArgv, resolve(process.argv[1])]
}

function chatProviders(): ChatProvider[] {
  const reporter: [string, ...string[]] = isSea()
    ? [process.execPath, '--report-chat']
    : [
        process.execPath,
        join(
          dirname(resolve(process.argv[1])),
          process.argv[1].endsWith('.ts')
            ? '../../scripts/report-chat.mjs'
            : 'report-chat.mjs',
        ),
      ]
  return [new CodexChatProvider(reporter), new ClaudeChatProvider(reporter)]
}

async function indexChatHistory(path: string): Promise<void> {
  const index = new ChatHistoryIndex(path)
  try {
    await index.update(chatProviders())
  } finally {
    index.close()
  }
}

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
  // The index copies conversations from transcripts that providers keep private, so only
  // the owner may enter its directory, whatever the permissions of the files SQLite creates.
  const historyDirectory = join(envPaths(APP_NAME).cache, 'chat-history')
  await mkdir(historyDirectory, { recursive: true, mode: 0o700 })
  const history = join(historyDirectory, 'index.sqlite')
  const server = await startServer(
    await resolveServerConfigPath(flags.config),
    new ProcessVscodeServerFactory(
      new DownloadedVscodeRuntime(new FetchHttpClient()),
      new NodeVscodeLauncher(),
    ),
    chatProviders(),
    new ChatHistory(
      history,
      new ProcessChatHistoryIndexer([
        ...selfCommand(),
        INDEX_CHAT_HISTORY,
        history,
      ]),
    ),
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

if (process.argv[2] === INDEX_CHAT_HISTORY)
  void indexChatHistory(process.argv[3]).catch((error: unknown) => {
    log.error({ err: error }, 'Chat history update failed')
    process.exitCode = 1
  })
else
  void main().catch((error: unknown) => {
    log.fatal({ err: error }, 'Server startup failed')
    process.exitCode = 1
  })
