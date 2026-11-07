import { basename } from 'node:path'
import type { BirpcReturn } from 'birpc'
import { z } from 'zod'
import type {
  Chat,
  ClientMethods,
  DesktopClientMethods,
  ExtensionClientMethods,
  ServerMethods,
  Worktree,
} from '../shared/api'
import { clientInfoSchema } from '../shared/api'
import { APP_NAME, RPC_PATH } from '../shared/constants'
import { logger } from '../shared/logger'
import { createConfigStore } from './config-store'
import { startRpcServer, type RpcServer } from './server'
import { WorktreeStore } from './worktree-store'
import type { VscodeServerFactory } from './vscode-server'
import { VscodeProxy } from './vscode-proxy'
import { VscodeSettingsStore, type SettingsStore } from './settings-store'
import { ChatStore } from './chat-store'
import { readDisabledExtensions } from './extension-enablement'
import { NodeProcessProbe } from './process-probe'
import { UnknownChatProviderError, type ChatProvider } from './chat-provider'
import { chatRoutes } from './chat-routes'
import type { ChatHistory } from './chat-history'

const log = logger.child({ component: 'server' })

export interface ServerApplication {
  readonly host: string
  readonly port: number
  close(): Promise<void>
}

export async function startServer(
  configPath: string,
  vscode: VscodeServerFactory,
  providers: ChatProvider[],
  // Owned by the server from here on, including when startup fails.
  history: ChatHistory,
): Promise<ServerApplication> {
  const config = await createConfigStore(configPath)
  const options = config.snapshot
  const worktrees = new WorktreeStore(options.projects, vscode)
  const chats = new ChatStore(new NodeProcessProbe(), providers)
  let server: RpcServer<ClientMethods, ServerMethods> | undefined
  let closing: Promise<void> | undefined
  let settings: SettingsStore | undefined
  const desktops = new Set<BirpcReturn<DesktopClientMethods, ServerMethods>>()
  const extensions = new Set<
    BirpcReturn<ExtensionClientMethods, ServerMethods>
  >()

  const sendChats = (
    client:
      | BirpcReturn<ExtensionClientMethods, ServerMethods>
      | BirpcReturn<DesktopClientMethods, ServerMethods>,
    snapshot: Record<string, Chat>,
  ) => {
    // Accepted limitation: the aggregate snapshot can still exceed MAX_RPC_PAYLOAD_BYTES,
    // causing client reconnect loops until the registry shrinks. We do not expect
    // enough simultaneous chats with large descriptions to reach that limit; aggregate
    // budgeting and chunking are intentionally out of scope.
    void client.chatsChanged.asEvent(snapshot).catch((error: unknown) => {
      if (!closing) log.warn({ err: error }, 'Failed to send chats to client')
    })
  }
  chats.setOnChangedListener((snapshot) => {
    for (const client of extensions) sendChats(client, snapshot)
    for (const client of desktops) sendChats(client, snapshot)
  })
  chats.setOnTurnFinishedListener((chat) => {
    for (const client of desktops) {
      void client.chatTurnFinished
        .asEvent(
          `${chat.providerId}:${chat.sessionId}`,
          chat.title,
          basename(chat.worktreePath),
          chat.description ?? '',
        )
        .catch((error: unknown) => {
          if (!closing)
            log.warn({ err: error }, 'Failed to send chat turn notification')
        })
    }
  })

  const sendSettings = (
    client: BirpcReturn<DesktopClientMethods, ServerMethods>,
    content: string | null,
  ) => {
    void client.settingsChanged.asEvent(content).catch((error: unknown) => {
      if (!closing)
        log.warn({ err: error }, 'Failed to send settings to client')
    })
  }

  const sendWorktrees = (
    client: BirpcReturn<DesktopClientMethods, ServerMethods>,
    snapshot: Worktree[],
  ) => {
    void client.worktreesChanged.asEvent(snapshot).catch((error: unknown) => {
      if (!closing)
        log.warn({ err: error }, 'Failed to send worktrees to client')
    })
  }
  worktrees.setOnChangedListener((snapshot) => {
    for (const client of desktops) sendWorktrees(client, snapshot)
  })
  config.setOnChangedListener((next) => {
    void worktrees.setProjects(next.projects).catch((error: unknown) => {
      if (!closing)
        log.error(
          { err: error },
          'Failed to refresh worktrees after configuration reload',
        )
    })
  })

  const close = () => {
    closing ??= (async () => {
      config.setOnChangedListener(undefined)
      worktrees.setOnChangedListener(undefined)
      chats.close()
      await Promise.all([
        config.close(),
        settings?.close(),
        history.close(),
        worktrees.close(),
        vscode.close(),
        server?.close(),
      ])
    })()
    return closing
  }
  try {
    history.setOnRefreshedListener(() => {
      for (const client of extensions) {
        void client.chatHistoryChanged.asEvent().catch((error: unknown) => {
          if (!closing)
            log.warn({ err: error }, 'Failed to send chat history change')
        })
      }
    })
    settings = await VscodeSettingsStore.open(options.vscode.settingsFile)
    settings.setOnChangedListener((content) => {
      for (const client of desktops) sendSettings(client, content)
    })
    await vscode.prepare(options.vscode.extensionsDirectory)
    await worktrees.queueRefresh()
    server = await startRpcServer<ClientMethods, ServerMethods>(
      {
        getChats: () => chats.snapshot,
        getChatProviders: () => providers.map(({ id, name }) => ({ id, name })),
        getChatCommand: (providerId, resumeSessionId) => {
          const provider = providers.find(
            (provider) => provider.id === providerId,
          )
          if (!provider) throw new UnknownChatProviderError(providerId)
          const command =
            config.snapshot.chatProviders[providerId]?.command ??
            provider.defaultCommand
          // The session ID becomes part of a shell command line.
          return resumeSessionId === undefined
            ? command
            : provider.resumeCommand(command, z.uuid().parse(resumeSessionId))
        },
        searchChatHistory: (query) => history.search(query),
        getServerInfo: () => ({ name: APP_NAME }),
        getDisabledExtensions: async () => {
          try {
            return readDisabledExtensions(options.vscode.profileDatabase)
          } catch (error) {
            log.warn({ err: error }, 'Failed to read host extension enablement')
            throw error
          }
        },
        writeSettings: (content) => settings!.write(content),
        refreshWorktrees: () => worktrees.queueRefresh(),
        getWorktreeChanges: (path) => worktrees.getWorktreeChanges(path),
        ensureVscodeServer: (path) => {
          const host =
            options.host === '0.0.0.0'
              ? '127.0.0.1'
              : options.host === '::'
                ? '::1'
                : options.host
          const authority = host.includes(':') ? `[${host}]` : host
          worktrees.ensureVscodeServer(
            path,
            `ws://${authority}:${server!.port}${RPC_PATH}`,
          )
        },
        stopVscodeServer: (path) => worktrees.stopVscodeServer(path),
        deleteWorktree: (path, branchName, force) =>
          worktrees.deleteWorktree(path, branchName, force),
        clearWorktreeError: (path, errorId) =>
          worktrees.clearWorktreeError(path, errorId),
      },
      options,
      async (client, signal) => {
        const info = clientInfoSchema.parse(await client.getClientInfo())
        if (signal.aborted || closing) return
        // The validated kind selects the peer's contract. Register and send the
        // current snapshot together so changes during identification are included.
        if (info.kind === 'extension') {
          const extension = client as BirpcReturn<
            ExtensionClientMethods,
            ServerMethods
          >
          extensions.add(extension)
          signal.addEventListener('abort', () => extensions.delete(extension), {
            once: true,
          })
          sendChats(extension, chats.snapshot)
        } else {
          const desktop = client as BirpcReturn<
            DesktopClientMethods,
            ServerMethods
          >
          desktops.add(desktop)
          signal.addEventListener(
            'abort',
            () => {
              desktops.delete(desktop)
            },
            { once: true },
          )
          sendChats(desktop, chats.snapshot)
          sendSettings(desktop, settings!.snapshot)
          sendWorktrees(desktop, worktrees.snapshot)
        }
      },
      new VscodeProxy(worktrees),
      async (app) => {
        app.register(chatRoutes, { chats })
      },
    )
    for (const provider of providers) await provider.install()
    log.info(
      { providerIds: providers.map((provider) => provider.id) },
      'Chat hooks installed',
    )
    void history.refresh()
  } catch (error) {
    await close()
    throw error
  }

  return { host: options.host, port: server.port, close }
}
