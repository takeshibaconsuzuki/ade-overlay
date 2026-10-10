import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { ClientMethods, ServerMethods, Worktree } from '../../shared/api'
import {
  CONNECTION_STATE_CHANGED,
  INITIALIZE,
  WORKTREES_CHANGED,
  WORKTREES_REFRESH,
} from '../api'
import { DEFAULT_SERVER_URL } from '../constants'
import { connectRpc } from '../../shared/rpc-client'
import { APP_DISPLAY_NAME, APP_NAME } from '../../shared/constants'
import { logger } from '../../shared/logger'

const log = logger.child({ component: 'desktop' })
let window: BrowserWindow | undefined

function createWindow(): void {
  window = new BrowserWindow({
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
  window.once('closed', () => {
    window = undefined
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  if (devServerUrl) {
    window.loadURL(devServerUrl)
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  let worktrees: Worktree[] = []
  const server = connectRpc<ServerMethods, ClientMethods>(
    process.env.ADE_SERVER_URL ?? DEFAULT_SERVER_URL,
    {
      getClientInfo: () => ({ name: APP_NAME, version: app.getVersion() }),
      worktreesChanged: (next) => {
        worktrees = next
        window?.webContents.send(WORKTREES_CHANGED, worktrees)
      },
    },
    {
      onStateChange: (state) => {
        log.info({ state }, 'Server connection changed')
        window?.webContents.send(CONNECTION_STATE_CHANGED, state)
      },
    },
  )
  ipcMain.on(INITIALIZE, (event) => {
    event.sender.send(CONNECTION_STATE_CHANGED, server.state)
    event.sender.send(WORKTREES_CHANGED, worktrees)
  })
  ipcMain.handle(WORKTREES_REFRESH, () => server.rpc.refreshWorktrees())
  app.once('before-quit', () => {
    void server.close()
  })
  createWindow()

  app.on('activate', () => {
    if (!window) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
