import type { BirpcReturn } from 'birpc'
import type { ClientMethods, ServerMethods, Worktree } from '../shared/api'
import { APP_NAME } from '../shared/constants'
import { logger } from '../shared/logger'
import { createConfigStore } from './config-store'
import { startRpcServer, type RpcServer } from './server'
import { WorktreeStore } from './worktree-store'

const log = logger.child({ component: 'server' })

export interface ServerApplication {
  readonly host: string
  readonly port: number
  close(): Promise<void>
}

export async function startServer(
  configPath: string,
): Promise<ServerApplication> {
  const config = await createConfigStore(configPath)
  const options = config.snapshot
  const worktrees = new WorktreeStore(options.projects)
  let server: RpcServer<ClientMethods, ServerMethods> | undefined
  let closing: Promise<void> | undefined

  const sendWorktrees = (
    client: BirpcReturn<ClientMethods, ServerMethods>,
    snapshot: Worktree[],
  ) => {
    void client.worktreesChanged.asEvent(snapshot).catch((error: unknown) => {
      if (!closing)
        log.warn({ err: error }, 'Failed to send worktrees to client')
    })
  }
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
      await Promise.all([config.close(), worktrees.close(), server?.close()])
    })()
    return closing
  }
  try {
    server = await startRpcServer<ClientMethods, ServerMethods>(
      {
        getServerInfo: () => ({ name: APP_NAME }),
        refreshWorktrees: () => worktrees.queueRefresh(),
      },
      options,
      (client) => sendWorktrees(client, worktrees.snapshot),
    )
    await worktrees.queueRefresh()
  } catch (error) {
    await close()
    throw error
  }

  return { host: options.host, port: server.port, close }
}
