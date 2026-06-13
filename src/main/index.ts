import { app } from 'electron'
import { Command } from 'commander'
import { createWindow as createControllerWindow } from './controller'
import { registerControllerIpcHandlers } from './controller/ipc'
import { startServer } from '../server'
import { logger } from '../server/logger'

const log = logger.child({ process: 'main' })

const command = new Command()
  .allowUnknownOption()
  .option('--role <role>')
  .parse(process.argv)

const { role } = command.opts<{ role?: string }>()

app.whenReady().then(async () => {
  switch (role) {
    default:
      registerControllerIpcHandlers()
      await startServer()
      createControllerWindow()
      log.info('controller window created')
      break
  }
})

process.on('uncaughtException', (error) => {
  log.fatal({ err: error }, 'uncaught exception in main process')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
