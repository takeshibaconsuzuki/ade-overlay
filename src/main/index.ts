import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { join } from 'node:path'
import { CompanionClient } from './companion-client.ts'
import { companionChannels } from '../shared/companion.ts'

const trustedRenderers = new Set<WebContents>()
const companion = new CompanionClient({
  url: process.env.ADE_COMPANION_URL,
  token: process.env.ADE_COMPANION_TOKEN,
})

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !trustedRenderers.has(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Untrusted companion API caller.')
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const renderer = window.webContents
  trustedRenderers.add(renderer)
  renderer.once('destroyed', () => trustedRenderers.delete(renderer))
  renderer.setWindowOpenHandler(() => ({ action: 'deny' }))
  renderer.on('will-navigate', (event) => event.preventDefault())

  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  if (devServerUrl) {
    window.loadURL(devServerUrl)
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle(companionChannels.getStatus, (event) => {
    assertTrustedSender(event)
    return companion.getStatus()
  })
  ipcMain.handle(companionChannels.reconnect, (event) => {
    assertTrustedSender(event)
    return companion.connect()
  })
  ipcMain.handle(companionChannels.listWorktrees, (event) => {
    assertTrustedSender(event)
    return companion.listWorktrees()
  })
  ipcMain.handle(companionChannels.refreshWorktrees, (event) => {
    assertTrustedSender(event)
    return companion.refreshWorktrees()
  })
  ipcMain.handle(companionChannels.createWorktree, (event, input) => {
    assertTrustedSender(event)
    return companion.createWorktree(input)
  })
  ipcMain.handle(companionChannels.deleteWorktree, (event, input) => {
    assertTrustedSender(event)
    return companion.deleteWorktree(input)
  })
  companion.on('worktreesUpdated', (update) => {
    for (const renderer of trustedRenderers) {
      if (!renderer.isDestroyed())
        renderer.send(companionChannels.worktreesUpdated, update)
    }
  })
  companion.on('status', (status) => {
    for (const renderer of trustedRenderers) {
      if (!renderer.isDestroyed())
        renderer.send(companionChannels.status, status)
    }
  })
  companion.connect()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => companion.stop())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
