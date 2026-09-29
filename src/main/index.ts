import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  dialog,
  Notification,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { join } from 'node:path'
import { CompanionClient } from './companion-client.ts'
import { CompanionState } from './companion-state.ts'
import { companionChannels, pickerChannels } from '../shared/ipc.ts'
import { EditorWindow } from './editor-window.ts'
import { EditorNavigation } from './editor-navigation.ts'
import { loadDesktopConfig } from './config.ts'
import { PickerWindow } from './picker-window.ts'
import { createWindowFocus } from './window-focus.ts'
import { ChatNotifications } from './chat-notifications.ts'

// Keep Chromium storage at the original location when the installer changes the
// visible product name. Editor cookies and settings must survive an upgrade.
app.setName('ade-overlay')
if (process.platform === 'win32')
  app.setAppUserModelId('io.github.takeshibaconsuzuki.ade-overlay')
let configuration: ReturnType<typeof loadDesktopConfig> = {}
let configurationError: unknown
try {
  configuration = loadDesktopConfig()
} catch (error) {
  configurationError = error
}

const trustedRenderers = new Set<WebContents>()
let pickerWindow: PickerWindow | undefined
const companion = new CompanionClient(configuration)
const chatNotifications = new ChatNotifications(
  (options) =>
    Notification.isSupported() ? new Notification(options) : undefined,
  (id) => companion.activateChat(id),
  (error) =>
    dialog.showErrorBox(
      'Could not open chat',
      error instanceof Error ? error.message : String(error),
    ),
)
const editorWindow = new EditorWindow(companion.getStatus().url)
const companionState = new CompanionState(companion)
const editorNavigation = new EditorNavigation(
  companion,
  editorWindow,
  companionState,
)

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !trustedRenderers.has(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Untrusted companion API caller.')
  }
}

function createWindow(canHide: boolean): PickerWindow {
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    // A macOS panel borrows keyboard focus without activating ADE, so hiding
    // it returns focus to the previous app/window through the native system.
    type: canHide && process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const picker = new PickerWindow(window, createWindowFocus(window), canHide)

  const renderer = window.webContents
  trustedRenderers.add(renderer)
  renderer.once('destroyed', () => trustedRenderers.delete(renderer))
  // The picker owns the desktop app's lifetime, including on macOS.
  window.once('closed', () => app.quit())
  window.on('hide', () => {
    if (!renderer.isDestroyed()) renderer.send(pickerChannels.hidden)
  })
  renderer.setWindowOpenHandler(() => ({ action: 'deny' }))
  renderer.on('will-navigate', (event) => event.preventDefault())

  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  if (devServerUrl) {
    window.loadURL(devServerUrl)
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  picker.show()
  return picker
}

app.whenReady().then(() => {
  if (configurationError) {
    dialog.showErrorBox(
      'Could not load ADE configuration',
      configurationError instanceof Error
        ? configurationError.message
        : 'Invalid desktop configuration.',
    )
    app.quit()
    return
  }
  const shortcut = 'CommandOrControl+Shift+Space'
  const registered = globalShortcut.register(shortcut, () => {
    pickerWindow?.toggle()
  })
  ipcMain.handle(pickerChannels.hide, (event) => {
    assertTrustedSender(event)
    pickerWindow?.hide()
  })
  ipcMain.handle(companionChannels.getState, (event) => {
    assertTrustedSender(event)
    return companionState.getCurrent()
  })
  ipcMain.handle(companionChannels.reconnect, (event) => {
    assertTrustedSender(event)
    editorNavigation.cancelSelectionRequest()
    companion.connect()
  })
  ipcMain.handle(companionChannels.refreshWorktrees, (event) => {
    assertTrustedSender(event)
    return companionState.refreshWorktrees()
  })
  ipcMain.handle(companionChannels.createWorktree, (event, input) => {
    assertTrustedSender(event)
    return companionState.createWorktree(input)
  })
  ipcMain.handle(companionChannels.deleteWorktree, (event, input) => {
    assertTrustedSender(event)
    return companionState.deleteWorktree(input)
  })
  ipcMain.handle(companionChannels.setWorktreeError, (event, input) => {
    assertTrustedSender(event)
    return companionState.setWorktreeError(input)
  })
  ipcMain.handle(companionChannels.openEditor, (event, input) => {
    assertTrustedSender(event)
    return editorNavigation.openWorktree(input)
  })
  companionState.on('snapshot', (snapshot) => editorWindow.reconcile(snapshot))
  companionState.on('changed', (state) => {
    for (const renderer of trustedRenderers) {
      if (!renderer.isDestroyed()) renderer.send(companionChannels.state, state)
    }
  })
  companion.on('chatActivate', ({ id, input }) => {
    void editorNavigation.openChat(id, input)
  })
  companion.on('chatFinished', (id) => {
    editorNavigation.finishChat(id)
  })
  companion.on('chatIdle', (chat) => chatNotifications.show(chat))
  companion.on('status', (status) => {
    if (status.state !== 'connected') {
      chatNotifications.clear()
      editorNavigation.cancelSelectionRequest()
    } else editorWindow.reconnectSettings()
  })
  companion.connect()
  pickerWindow = createWindow(registered)
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  chatNotifications.clear()
  editorWindow.close()
  companion.stop()
})
