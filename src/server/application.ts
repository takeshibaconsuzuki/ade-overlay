import type { BirpcReturn } from 'birpc'
import type {
  ClientMethods,
  ServerMethods,
  Worktree,
  VscodeServerStatus,
} from '../shared/api'
import { APP_NAME } from '../shared/constants'
import { logger } from '../shared/logger'
import { createConfigStore } from './config-store'
import { startRpcServer, type RpcServer } from './server'
import { WorktreeStore } from './worktree-store'
import type { VscodeServerManager } from './vscode-manager'
import { VscodeProxy } from './vscode-proxy'
import { VscodeSettingsStore, type SettingsStore } from './settings-store'

const log = logger.child({ component: 'server' })

export interface ServerApplication {
  readonly host: string
  readonly port: number
  close(): Promise<void>
}

export async function startServer(
  configPath: string,
  vscode: VscodeServerManager,
): Promise<ServerApplication> {
  const config = await createConfigStore(configPath)
  const options = config.snapshot
  const worktrees = new WorktreeStore(options.projects)
  let server: RpcServer<ClientMethods, ServerMethods> | undefined
  let closing: Promise<void> | undefined
  let settings: SettingsStore | undefined

  const sendSettings = (
    client: BirpcReturn<ClientMethods, ServerMethods>,
    content: string | null,
  ) => {
    void client.settingsChanged.asEvent(content).catch((error: unknown) => {
      if (!closing)
        log.warn({ err: error }, 'Failed to send settings to client')
    })
  }

  const sendWorktrees = (
    client: BirpcReturn<ClientMethods, ServerMethods>,
    snapshot: Worktree[],
  ) => {
    void client.worktreesChanged.asEvent(snapshot).catch((error: unknown) => {
      if (!closing)
        log.warn({ err: error }, 'Failed to send worktrees to client')
    })
  }
  const sendVscodeServers = (
    client: BirpcReturn<ClientMethods, ServerMethods>,
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
    for (const client of server?.clients ?? [])
      sendVscodeServers(client, snapshot)
  })
  worktrees.setOnChangedListener((snapshot) => {
    for (const client of server?.clients ?? []) sendWorktrees(client, snapshot)
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
      for (const client of server?.clients ?? []) sendSettings(client, content)
    })
    await vscode.prepare(options.vscode.extensionsDirectory)
    await worktrees.queueRefresh()
    server = await startRpcServer<ClientMethods, ServerMethods>(
      {
        getServerInfo: () => ({ name: APP_NAME }),
        writeSettings: (content) => settings!.write(content),
        refreshWorktrees: () => worktrees.queueRefresh(),
        ensureVscodeServer: (path) => {
          const worktree = worktrees.snapshot.find(
            (worktree) => worktree.path === path,
          )
          if (!worktree) throw new Error('Unknown worktree')
          vscode.ensure(worktree.path)
        },
        clearVscodeServerError: (path, errorId) =>
          vscode.clearError(path, errorId),
      },
      options,
      (client) => {
        sendSettings(client, settings!.snapshot)
        sendVscodeServers(client, vscode.snapshot)
        sendWorktrees(client, worktrees.snapshot)
      },
      new VscodeProxy(vscode),
    )
  } catch (error) {
    await close()
    throw error
  }

  return { host: options.host, port: server.port, close }
}
