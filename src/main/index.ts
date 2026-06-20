import { parseArgs } from 'node:util'
import { app, nativeTheme } from 'electron'
import { startServer } from '../server'
import { flushLogs, logger } from '../server/logger'
import {
  createWindow as createChatWindow,
  registerChatIpcHandlers,
} from './chat'
import { createWindow as createControllerWindow } from './controller'
import { registerControllerIpcHandlers } from './controller/ipc'
import { registerWorktreeCreationNotifications } from './controller/worktreeNotifications'
import { setRoleDockIcon } from './dockIcon'
import { createWindow as createEditorWindow } from './editor'
import { registerMainIpcHandlers } from './ipc'

const log = logger.child({ process: 'main' })
const cliOptions = parseAppCliOptions(process.argv)
let server: Awaited<ReturnType<typeof startServer>> | null = null
let stopWorktreeCreationNotifications: (() => void) | null = null
let quitInProgress = false
let shutdownComplete = false

process.on('uncaughtException', (error) => {
  void fatalShutdown(error, 'uncaught exception in main process')
})

process.on('unhandledRejection', (error) => {
  void fatalShutdown(error, 'unhandled rejection in main process')
})

log.debug(
  { argv: process.argv, execPath: process.execPath, cliOptions },
  'app role parsed',
)

void main().catch((error: unknown) => {
  void fatalShutdown(error, 'main process startup failed')
})

app.on('before-quit', (event) => {
  if (shutdownComplete) {
    return
  }

  event.preventDefault()
  if (quitInProgress) {
    return
  }

  quitInProgress = true
  log.info('shutting down')
  void shutdown()
    .finally(() => {
      shutdownComplete = true
      log.info('shutdown complete')
    })
    // Drain shipped logs (editor process) before the process exits, so the
    // shutdown trail is not lost in flight.
    .finally(() => flushLogs())
    .finally(() => {
      app.quit()
    })
})

async function main(): Promise<void> {
  // The renderer locks Radix to its dark appearance; force native chrome (the
  // worktrees window's titlebar, menus, scrollbars) dark to match.
  nativeTheme.themeSource = 'dark'

  switch (cliOptions.role) {
    case 'editor':
      app.setName('ADE Editor')
      await app.whenReady()
      setRoleDockIcon('editor')
      createEditorWindow()
      log.info('editor window created')
      break
    case 'chat':
      app.setName('ADE Chat')
      await app.whenReady()
      setRoleDockIcon('chat')
      registerMainIpcHandlers()
      registerChatIpcHandlers()
      createChatWindow()
      log.info('chat window created')
      break
    default:
      server = await startServer()
      await app.whenReady()
      setRoleDockIcon('controller')
      stopWorktreeCreationNotifications =
        registerWorktreeCreationNotifications(log)
      registerMainIpcHandlers()
      registerControllerIpcHandlers()
      createControllerWindow()
      log.info('controller window created')
      break
  }
}

async function shutdown(): Promise<void> {
  if (!server) {
    return
  }

  stopWorktreeCreationNotifications?.()
  stopWorktreeCreationNotifications = null

  const serverToClose = server
  server = null
  const destroyActiveConnections = (
    serverToClose as { destroyActiveConnections?: () => void }
  ).destroyActiveConnections
  destroyActiveConnections?.()
  serverToClose.server.closeAllConnections()
  await serverToClose.close()
}

async function fatalShutdown(error: unknown, message: string): Promise<void> {
  log.fatal({ err: error }, message)
  try {
    await shutdown()
  } catch (shutdownError) {
    log.fatal({ err: shutdownError }, 'main process shutdown failed')
  } finally {
    await flushLogs()
    app.exit(1)
  }
}

type AppCliOptions = {
  role?: string
}

function parseAppCliOptions(argv: string[]): AppCliOptions {
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      role: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  })
  return {
    role: typeof values.role === 'string' ? values.role : undefined,
  }
}
