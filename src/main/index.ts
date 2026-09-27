import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { join } from 'node:path'
import { CompanionClient } from './companion-client.ts'
import {
  companionChannels,
  type WorktreeSnapshot,
} from '../shared/companion.ts'
import { EditorWindow } from './editor-window.ts'

const trustedRenderers = new Set<WebContents>()
const editorWindow = new EditorWindow()
let editorRequest = 0
let connectionEpoch = 0
let editorRevision = -1
const companion = new CompanionClient({
  url: process.env.ADE_COMPANION_URL,
  token: process.env.ADE_COMPANION_TOKEN,
})

function reconcileEditors(snapshot: WorktreeSnapshot, epoch: number): void {
  if (epoch !== connectionEpoch || snapshot.revision < editorRevision) return
  editorRevision = snapshot.revision
  editorWindow.reconcile(snapshot)
}

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
  // The picker owns the desktop app's lifetime, including on macOS.
  window.once('closed', () => app.quit())
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
    editorRequest++
    editorWindow.cancelPending()
    return companion.connect()
  })
  ipcMain.handle(companionChannels.listWorktrees, async (event) => {
    assertTrustedSender(event)
    const epoch = connectionEpoch
    const snapshot = await companion.listWorktrees()
    reconcileEditors(snapshot, epoch)
    return snapshot
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
  ipcMain.handle(companionChannels.setWorktreeError, (event, input) => {
    assertTrustedSender(event)
    return companion.setWorktreeError(input)
  })
  ipcMain.handle(companionChannels.openEditor, async (event, input) => {
    assertTrustedSender(event)
    const request = ++editorRequest
    try {
      const editor = await companion.openEditor(input)
      if (request !== editorRequest) return
      await editorWindow.open(companion.getStatus().url, editor, input)
    } catch (error) {
      if (request !== editorRequest) return
      try {
        await companion.setWorktreeError({
          project: input.project,
          path: input.path,
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            4096,
          ),
        })
      } catch {
        // Fall back to a local row error only when the companion cannot own it.
        throw error
      }
    }
  })
  companion.on('worktreesUpdated', (update) => {
    reconcileEditors(update.snapshot, connectionEpoch)
    for (const renderer of trustedRenderers) {
      if (!renderer.isDestroyed())
        renderer.send(companionChannels.worktreesUpdated, update)
    }
  })
  companion.on('status', (status) => {
    connectionEpoch++
    editorRevision = -1
    if (status.state !== 'connected') {
      editorRequest++
      editorWindow.cancelPending()
    } else editorWindow.reconnectSettings()
    for (const renderer of trustedRenderers) {
      if (!renderer.isDestroyed())
        renderer.send(companionChannels.status, status)
    }
  })
  companion.connect()
  createWindow()
})

app.on('before-quit', () => {
  editorWindow.close()
  companion.stop()
})
