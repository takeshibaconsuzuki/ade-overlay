import { Command } from 'commander'
import { app } from 'electron'
import { startServer } from '../server'
import { flushLogs, logger } from '../server/logger'
import { createWindow as createControllerWindow } from './controller'
import { registerControllerIpcHandlers } from './controller/ipc'
import { registerWorktreeCreationNotifications } from './controller/worktreeNotifications'
import { createWindow as createEditorWindow } from './editor'

const log = logger.child({ process: 'main' })
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

const command = new Command()
  .allowUnknownOption()
  .option('--role <role>')
  .parse(process.argv)

const { role } = command.opts<{ role?: string }>()

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
  switch (role) {
    case 'editor':
      app.setName('ADE Editor')
      await app.whenReady()
      createEditorWindow()
      log.info('editor window created')
      break
    default:
      server = await startServer()
      await app.whenReady()
      stopWorktreeCreationNotifications =
        registerWorktreeCreationNotifications(log)
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
