import { app } from 'electron'
import { Command } from 'commander'
import { createWindow as createControllerWindow } from './controller'
import { startServer } from '../server'

const command = new Command()
  .allowUnknownOption()
  .option('--role <role>')
  .parse(process.argv)

const { role } = command.opts<{ role?: string }>()

app.whenReady().then(async () => {
  switch (role) {
    default:
      await startServer()
      createControllerWindow()
      break
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
