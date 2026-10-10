import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { ClientMethods, ServerMethods } from '../../shared/api'
import { DEFAULT_SERVER_URL } from '../constants'
import { connectRpc } from '../../shared/rpc-client'
import { APP_DISPLAY_NAME, APP_NAME } from '../../shared/constants'
import { logger } from '../../shared/logger'

const log = logger.child({ component: 'desktop' })

function createWindow(): void {
  const window = new BrowserWindow({
    title: APP_DISPLAY_NAME,
    width: 900,
    height: 600,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  if (devServerUrl) {
    window.loadURL(devServerUrl)
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const server = connectRpc<ServerMethods, ClientMethods>(
    process.env.ADE_SERVER_URL ?? DEFAULT_SERVER_URL,
    {
      getClientInfo: () => ({ name: APP_NAME, version: app.getVersion() }),
    },
    {
      onStateChange: (state) =>
        log.info({ state }, 'Server connection changed'),
    },
  )
  app.once('before-quit', () => {
    void server.close()
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
