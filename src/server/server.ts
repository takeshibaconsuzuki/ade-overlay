import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from 'pino'
import { DEFAULT_COMPANION_PORT } from '../shared/companion.ts'
import {
  loadServerConfig,
  editorDataDir,
  serverConfigSchema,
  type ServerConfig,
} from './config.ts'
import { ChatService } from './chats/chat-service.ts'
import { ChatStore } from './chats/chat-store.ts'
import { WorktreeColors } from './worktrees/worktree-colors.ts'
import { EditorManager } from './editors/editor-manager.ts'
import type { EditorRuntimeProvider } from './editors/vscode-runtime.ts'
import { WorktreeStore } from './worktrees/worktree-store.ts'
import { createEditorTransport } from './editors/editor-transport.ts'
import { createCompanionTransport } from './companion-transport.ts'
import { rejectUpgrade } from './transport.ts'
import { silentLogger } from './logging.ts'

export interface ServerOptions {
  editorRuntime?: EditorRuntimeProvider
  logger?: Logger
  host?: string
  port?: number
  token?: string
  heartbeatIntervalMs?: number
  configPath?: string
  config?: ServerConfig
}

export async function startCompanionServer(options: ServerOptions = {}) {
  const logger = options.logger ?? silentLogger
  logger.info('Loading configuration and discovering worktrees')
  // Finish config validation and discovery before binding any listening socket.
  const config =
    options.config === undefined
      ? await loadServerConfig(options.configPath)
      : serverConfigSchema.parse(options.config)
  const colors = await WorktreeColors.open(editorDataDir(config.editor))
  const chats: ChatService = new ChatService(
    logger,
    new ChatStore(undefined, (worktree) =>
      editors.status(worktree) === 'stopped' ? undefined : colors.get(worktree),
    ),
    join(editorDataDir(config.editor), 'paste-images'),
  )
  const editors = new EditorManager(
    chats,
    config.editor,
    logger,
    options.editorRuntime,
  )
  editors.on('status', () => chats.store.refreshColors())
  let worktrees: WorktreeStore | undefined
  let editorTransport: ReturnType<typeof createEditorTransport> | undefined
  let companionTransport:
    | ReturnType<typeof createCompanionTransport>
    | undefined
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/editors/'))
      editorTransport!.handleRequest(request, response)
    else response.writeHead(404).end('Not found')
  })
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy())
    if (request.url?.startsWith('/editors/'))
      editorTransport!.handleUpgrade(request, socket, head)
    else if (request.url?.split('?')[0] === '/companion')
      companionTransport!.handleUpgrade(request, socket, head)
    else rejectUpgrade(socket, '404 Not Found')
  })

  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    closing ??= (async () => {
      const worktreesClosed = worktrees?.close()
      // Stop accepting connections before closing transports. Upgraded sockets
      // belong to those transports; closeAllConnections only handles HTTP.
      const listenerClosed = new Promise<void>((resolve, reject) => {
        server.close((error?: NodeJS.ErrnoException) =>
          error && error.code !== 'ERR_SERVER_NOT_RUNNING'
            ? reject(error)
            : resolve(),
        )
      })
      server.closeAllConnections()
      editorTransport?.close()
      const results = await Promise.allSettled([
        listenerClosed,
        chats.close(),
        companionTransport?.close(),
      ])
      try {
        await worktreesClosed
      } finally {
        await editors.close()
      }
      for (const result of results)
        if (result.status === 'rejected') throw result.reason
    })()
    return closing
  }

  try {
    worktrees = await WorktreeStore.open(config.projects, editors, colors)
    worktrees.on('operationFailed', (worktree, error) => {
      logger.error(
        { project: worktree.project, path: worktree.path, err: error },
        'Worktree operation failed',
      )
    })
    editorTransport = createEditorTransport({
      target: (id) => editors.target(id),
      activation: (id) => chats.activation(id),
      logger,
    })
    companionTransport = createCompanionTransport({
      worktrees,
      chats,
      logger,
      token: options.token,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
    })
    await chats.listen()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(
        options.port ?? DEFAULT_COMPANION_PORT,
        options.host ?? '127.0.0.1',
        () => {
          server.removeListener('error', reject)
          resolve()
        },
      )
    })
  } catch (error) {
    await close().catch((cleanupError: unknown) =>
      logger.error({ err: cleanupError }, 'Companion startup cleanup failed'),
    )
    throw error
  }

  const address = server.address() as AddressInfo
  const urlHost =
    address.family === 'IPv6' ? `[${address.address}]` : address.address
  return {
    url: `ws://${urlHost}:${address.port}/companion`,
    prepareEditorRuntime(): void {
      editors.prepareRuntime()
    },
    close,
  }
}
