import type { BirpcReturn } from 'birpc'
import type {
  Chat,
  ClientMethods,
  DesktopClientMethods,
  ExtensionClientMethods,
  ServerMethods,
  Worktree,
  VscodeServerStatus,
} from '../shared/api'
import { clientInfoSchema } from '../shared/api'
import { APP_NAME, RPC_PATH } from '../shared/constants'
import { logger } from '../shared/logger'
import { createConfigStore } from './config-store'
import { startRpcServer, type RpcServer } from './server'
import { WorktreeStore } from './worktree-store'
import type { VscodeServerManager } from './vscode-manager'
import { VscodeProxy } from './vscode-proxy'
import { VscodeSettingsStore, type SettingsStore } from './settings-store'
import { ChatStore } from './chat-store'
import { NodeProcessProbe } from './process-probe'
import type { ChatProvider } from './chat-provider'
import { chatRoutes } from './chat-routes'
import { MAX_CHAT_DESCRIPTION_LENGTH } from './constants'

const log = logger.child({ component: 'server' })

export interface ServerApplication {
  readonly host: string
  readonly port: number
  close(): Promise<void>
}

export async function startServer(
  configPath: string,
  vscode: VscodeServerManager,
  providers: ChatProvider[],
): Promise<ServerApplication> {
  const config = await createConfigStore(configPath)
  const options = config.snapshot
  const worktrees = new WorktreeStore(options.projects)
  const chats = new ChatStore(new NodeProcessProbe(), providers)
  let server: RpcServer<ClientMethods, ServerMethods> | undefined
  let closing: Promise<void> | undefined
  let settings: SettingsStore | undefined
  const desktops = new Set<BirpcReturn<DesktopClientMethods, ServerMethods>>()
  const extensions = new Set<
    BirpcReturn<ExtensionClientMethods, ServerMethods>
  >()

  const sendChats = (
    client: BirpcReturn<ExtensionClientMethods, ServerMethods>,
    snapshot: Record<string, Chat>,
  ) => {
    // Sidebar descriptions are previews; keep full reports in the registry.
    // Accepted limitation: the aggregate snapshot can still exceed MAX_RPC_PAYLOAD_BYTES,
    // causing extension reconnect loops until the registry shrinks. We do not expect
    // enough simultaneous chats with large descriptions to reach that limit; aggregate
    // budgeting and chunking are intentionally out of scope.
    const preview = Object.fromEntries(
      Object.entries(snapshot).map(([id, chat]) => [
        id,
        {
          ...chat,
          description:
            chat.description === undefined
              ? undefined
              : Array.from(chat.description)
                  .slice(0, MAX_CHAT_DESCRIPTION_LENGTH)
                  .join(''),
        },
      ]),
    )
    void client.chatsChanged.asEvent(preview).catch((error: unknown) => {
      if (!closing) log.warn({ err: error }, 'Failed to send chats to client')
    })
  }
  chats.setOnChangedListener((snapshot) => {
    for (const client of extensions) sendChats(client, snapshot)
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
  const sendVscodeServers = (
    client: BirpcReturn<DesktopClientMethods, ServerMethods>,
    snapshot: VscodeServerStatus[],
  ) => {
    void client.vscodeServersChanged
      .asEvent(snapshot)
      .catch((error: unknown) => {
        if (!closing)
          log.warn({ err: error }, 'Failed to send VS Code status to client')
      })
  }
  vscode.setOnChangedListener((snapshot) => {
    for (const client of desktops) sendVscodeServers(client, snapshot)
  })
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
      vscode.setOnChangedListener(undefined)
      chats.close()
      await Promise.all([
        config.close(),
        settings?.close(),
        worktrees.close(),
        vscode.close(),
        server?.close(),
      ])
    })()
    return closing
  }
  try {
    settings = await VscodeSettingsStore.open(options.vscode.settingsFile)
    settings.setOnChangedListener((content) => {
      for (const client of desktops) sendSettings(client, content)
    })
    await vscode.prepare(options.vscode.extensionsDirectory)
    await worktrees.queueRefresh()
    server = await startRpcServer<ClientMethods, ServerMethods>(
      {
        getChats: () => chats.snapshot,
        getServerInfo: () => ({ name: APP_NAME }),
        writeSettings: (content) => settings!.write(content),
        refreshWorktrees: () => worktrees.queueRefresh(),
        ensureVscodeServer: (path) => {
          const worktree = worktrees.snapshot.find(
            (worktree) => worktree.path === path,
          )
          if (!worktree) throw new Error('Unknown worktree')
          const host =
            options.host === '0.0.0.0'
              ? '127.0.0.1'
              : options.host === '::'
                ? '::1'
                : options.host
          const authority = host.includes(':') ? `[${host}]` : host
          vscode.ensure(
            worktree.path,
            `ws://${authority}:${server!.port}${RPC_PATH}`,
          )
        },
        clearVscodeServerError: (path, errorId) =>
          vscode.clearError(path, errorId),
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
          signal.addEventListener('abort', () => desktops.delete(desktop), {
            once: true,
          })
          sendSettings(desktop, settings!.snapshot)
          sendVscodeServers(desktop, vscode.snapshot)
          sendWorktrees(desktop, worktrees.snapshot)
        }
      },
      new VscodeProxy(vscode),
      async (app) => {
        app.register(chatRoutes, { chats })
      },
    )
    for (const provider of providers) await provider.install()
  } catch (error) {
    await close()
    throw error
  }

  return { host: options.host, port: server.port, close }
}
