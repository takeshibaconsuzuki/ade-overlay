import { app, type BrowserWindow, globalShortcut, ipcMain } from 'electron'
import type {
  ClientMethods,
  ServerMethods,
  Worktree,
  VscodeServerStatus,
} from '../shared/api'
import {
  CONNECTION_STATE_CHANGED,
  WORKTREE_PICKER_INITIALIZE,
  WORKTREES_CHANGED,
  WORKTREES_REFRESH,
  VSCODE_SERVERS_CHANGED,
  WORKTREE_OPEN,
  VSCODE_SERVER_CLEAR_ERROR,
} from './picker/api'
import { DEFAULT_SERVER_URL } from './constants'
import { connectRpc } from '../shared/rpc-client'
import { APP_NAME } from '../shared/constants'
import { logger } from '../shared/logger'
import { EditorWindowManager } from './editor/manager'
import { ElectronEditorWindow } from './editor/window'
import { EDITOR_INITIALIZE, EDITOR_RETRY } from './editor/api'
import { createWorktreePickerWindow } from './picker/window'

const log = logger.child({ component: 'desktop' })
let worktreePickerWindow: BrowserWindow | undefined

app.whenReady().then(() => {
  const pickerShortcut = 'CommandOrControl+Shift+Space'
  if (
    !globalShortcut.register(pickerShortcut, () => {
      if (worktreePickerWindow?.isVisible()) {
        // Relinquish focus before hiding; blur cannot activate another window once hidden.
        if (worktreePickerWindow.isFocused()) worktreePickerWindow.blur()
        worktreePickerWindow.hide()
      } else {
        worktreePickerWindow?.show()
      }
    })
  ) {
    log.error(
      { shortcut: pickerShortcut },
      'Picker shortcut registration failed; aborting startup',
    )
    app.exit(1)
    return
  }
  app.once('will-quit', () => {
    globalShortcut.unregister(pickerShortcut)
  })
  let worktrees: Worktree[] = []
  let vscodeServers: VscodeServerStatus[] = []
  const editorHost = new ElectronEditorWindow({
    writeSettings: (content) => server.rpc.writeSettings(content),
  })
  const serverUrl = process.env.ADE_SERVER_URL ?? DEFAULT_SERVER_URL
  const editor = new EditorWindowManager(
    editorHost,
    { ensure: (path): Promise<void> => server.rpc.ensureVscodeServer(path) },
    serverUrl,
  )
  const server = connectRpc<ServerMethods, ClientMethods>(
    serverUrl,
    {
      getClientInfo: () => ({ name: APP_NAME, version: app.getVersion() }),
      settingsChanged: (content) => editorHost.receiveVscodeSettings(content),
      worktreesChanged: (next) => {
        worktrees = next
        worktreePickerWindow?.webContents.send(WORKTREES_CHANGED, worktrees)
      },
      vscodeServersChanged: (next) => {
        vscodeServers = next
        editor.updateStatuses(next)
        worktreePickerWindow?.webContents.send(
          VSCODE_SERVERS_CHANGED,
          vscodeServers,
        )
      },
    },
    {
      onStateChange: (state) => {
        editorHost.receiveVscodeSettings(null)
        if (state !== 'connected') {
          worktrees = []
          vscodeServers = []
          editor.onServerDisconnected()
          worktreePickerWindow?.webContents.send(
            VSCODE_SERVERS_CHANGED,
            vscodeServers,
          )
          worktreePickerWindow?.webContents.send(WORKTREES_CHANGED, worktrees)
        }
        log.info({ state }, 'Server connection changed')
        worktreePickerWindow?.webContents.send(CONNECTION_STATE_CHANGED, state)
      },
    },
  )
  ipcMain.on(EDITOR_INITIALIZE, (event) => {
    if (!editorHost.isAdeSender(event.sender)) return
    editorHost.sendShellState()
  })
  ipcMain.on(WORKTREE_PICKER_INITIALIZE, (event) => {
    if (event.sender !== worktreePickerWindow?.webContents) return
    event.sender.send(CONNECTION_STATE_CHANGED, server.state)
    event.sender.send(WORKTREES_CHANGED, worktrees)
    event.sender.send(VSCODE_SERVERS_CHANGED, vscodeServers)
  })
  ipcMain.handle(WORKTREES_REFRESH, (event) => {
    if (event.sender !== worktreePickerWindow?.webContents)
      throw new Error('Invalid sender')
    return server.rpc.refreshWorktrees()
  })
  ipcMain.handle(WORKTREE_OPEN, (event, path: string) => {
    if (event.sender !== worktreePickerWindow?.webContents)
      throw new Error('Invalid sender')
    const worktree = worktrees.find((worktree) => worktree.path === path)
    if (!worktree) throw new Error('Unknown worktree')
    return editor.open(worktree)
  })
  ipcMain.handle(EDITOR_RETRY, (event) => {
    if (!editorHost.isAdeSender(event.sender)) throw new Error('Invalid sender')
    return editor.retry()
  })
  ipcMain.handle(
    VSCODE_SERVER_CLEAR_ERROR,
    (event, path: string, errorId: string) => {
      if (event.sender !== worktreePickerWindow?.webContents)
        throw new Error('Invalid sender')
      return server.rpc.clearVscodeServerError(path, errorId)
    },
  )
  let quitting: Promise<void> | undefined
  let readyToQuit = false
  app.on('before-quit', (event) => {
    if (readyToQuit) return
    event.preventDefault()
    quitting ??= (async () => {
      try {
        await editor.close()
        await server.close()
      } catch (error) {
        log.error({ err: error }, 'Desktop shutdown failed')
      } finally {
        readyToQuit = true
        app.quit()
      }
    })()
  })
  worktreePickerWindow = createWorktreePickerWindow()
  worktreePickerWindow.once('closed', () => {
    worktreePickerWindow = undefined
    app.quit()
  })
})
