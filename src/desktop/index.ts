import {
  app,
  type BrowserWindow,
  globalShortcut,
  ipcMain,
  dialog,
  Notification,
} from 'electron'
import type {
  DesktopClientMethods,
  ServerMethods,
  Worktree,
} from '../shared/api'
import {
  CONNECTION_STATE_CHANGED,
  WORKTREE_PICKER_INITIALIZE,
  WORKTREE_PICKER_VISIBILITY_CHANGED,
  WORKTREES_CHANGED,
  WORKTREES_REFRESH,
  VSCODE_SERVER_STOP,
  WORKTREE_DELETE,
  WORKTREE_OPEN,
  WORKTREE_CLEAR_ERROR,
} from './picker/api'
import { DEFAULT_SERVER_URL } from '../shared/constants'
import { connectRpc } from '../shared/rpc-client'
import { APP_NAME } from '../shared/constants'
import { logger } from '../shared/logger'
import { DesktopChatService } from './chat-service'
import { EditorWindowManager } from './editor/manager'
import { ElectronEditorWindow } from './editor/window'
import { EDITOR_INITIALIZE, EDITOR_RETRY } from './editor/api'
import { createWorktreePickerWindow } from './picker/window'
import { WorktreeOrder } from './picker/worktree-order'
import { ClipboardService } from './clipboard/service'
import { ElectronClipboardSource } from './clipboard/electron'
import { UrlClipboardImageReader } from './clipboard/image-reader'
import { HtmlClipboardNormalizer } from './clipboard/html'
import { TextClipboardNormalizer } from './clipboard/text'
import { FetchHttpClient } from '../shared/http-client'

const log = logger.child({ component: 'desktop' })
let worktreePickerWindow: BrowserWindow | undefined

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId(APP_NAME)
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
  const worktreeOrder = new WorktreeOrder()
  const publishWorktrees = () => {
    worktreePickerWindow?.webContents.send(
      WORKTREES_CHANGED,
      worktreeOrder.sort(worktrees),
    )
  }
  const clipboard = new ClipboardService(new ElectronClipboardSource(), [
    new HtmlClipboardNormalizer(
      new UrlClipboardImageReader(new FetchHttpClient()),
    ),
    new TextClipboardNormalizer(),
  ])
  const editorHost = new ElectronEditorWindow(
    { writeSettings: (content) => server.rpc.writeSettings(content) },
    () => server.rpc.getDisabledExtensions(),
    {
      openChat: (id): Promise<void> => chats.openChat(id),
      openChatTerminal: (options): Promise<void> =>
        chats.openChatTerminal(options),
      readClipboard: () => clipboard.readClipboard(),
    },
  )
  const serverUrl = process.env.ADE_SERVER_URL ?? DEFAULT_SERVER_URL
  const editor = new EditorWindowManager(
    editorHost,
    { ensure: (path): Promise<void> => server.rpc.ensureVscodeServer(path) },
    serverUrl,
    (path) => {
      worktreeOrder.recordOpen(path)
      publishWorktrees()
    },
  )
  const chats = new DesktopChatService(editor)
  const openWorktree = (path: string): Promise<void> => {
    const worktree = worktrees.find((worktree) => worktree.path === path)
    if (!worktree) throw new Error('Unknown worktree')
    return editor.open(worktree)
  }
  const server = connectRpc<ServerMethods, DesktopClientMethods>(
    serverUrl,
    {
      getClientInfo: () => ({
        kind: 'desktop',
        name: APP_NAME,
        version: app.getVersion(),
      }),
      settingsChanged: (content) => editorHost.receiveVscodeSettings(content),
      chatTurnFinished: (title, worktreeBasename, description) => {
        new Notification({
          title,
          body: `${worktreeBasename}\n${description.slice(0, 8_000)}`,
        }).show()
      },
      chatsChanged: (snapshot) => chats.updateChats(snapshot),
      worktreesChanged: (next) => {
        worktrees = next
        chats.updateWorktrees(next)
        editor.updateWorktrees(next)
        publishWorktrees()
      },
    },
    {
      onStateChange: (state) => {
        editorHost.receiveVscodeSettings(null)
        if (state !== 'connected') {
          chats.disconnect()
          worktrees = []
          editor.onServerDisconnected()
          publishWorktrees()
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
    event.sender.send(WORKTREES_CHANGED, worktreeOrder.sort(worktrees))
    event.sender.send(
      WORKTREE_PICKER_VISIBILITY_CHANGED,
      worktreePickerWindow.isVisible(),
    )
  })
  ipcMain.handle(WORKTREES_REFRESH, (event) => {
    if (event.sender !== worktreePickerWindow?.webContents)
      throw new Error('Invalid sender')
    return server.rpc.refreshWorktrees()
  })
  ipcMain.handle(WORKTREE_OPEN, (event, path: string) => {
    if (event.sender !== worktreePickerWindow?.webContents)
      throw new Error('Invalid sender')
    return openWorktree(path)
  })
  ipcMain.handle(EDITOR_RETRY, (event) => {
    if (!editorHost.isAdeSender(event.sender)) throw new Error('Invalid sender')
    return editor.retry()
  })
  ipcMain.handle(
    WORKTREE_CLEAR_ERROR,
    (event, path: string, errorId: string) => {
      if (event.sender !== worktreePickerWindow?.webContents)
        throw new Error('Invalid sender')
      return server.rpc.clearWorktreeError(path, errorId)
    },
  )
  ipcMain.handle(VSCODE_SERVER_STOP, (event, path: string) => {
    if (event.sender !== worktreePickerWindow?.webContents)
      throw new Error('Invalid sender')
    return server.rpc.stopVscodeServer(path)
  })
  ipcMain.handle(
    WORKTREE_DELETE,
    async (event, path: string, branchName?: string) => {
      if (event.sender !== worktreePickerWindow?.webContents)
        throw new Error('Invalid sender')
      const worktree = worktrees.find((worktree) => worktree.path === path)
      if (!worktree) throw new Error('Unknown worktree')
      if (branchName !== undefined && branchName !== worktree.branchName)
        throw new Error('Worktree branch changed; refresh and try again')
      const action =
        branchName === undefined
          ? 'Delete worktree'
          : 'Delete worktree and branch'
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message:
          branchName === undefined
            ? `Delete worktree ${worktree.basename}?`
            : `Delete worktree ${worktree.basename} and branch ${branchName}?`,
        detail:
          'Its VS Code server will stop and its directory will be removed. Worktrees with uncommitted changes will not be deleted.' +
          (branchName === undefined
            ? ''
            : ' Its local branch will then be deleted if Git considers it safely merged. If branch deletion fails, the worktree will still be removed and the error will appear on the main worktree.'),
        buttons: ['Cancel', action],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (response !== 1) return
      if (branchName === undefined) await server.rpc.deleteWorktree(path)
      else await server.rpc.deleteWorktree(path, branchName)
    },
  )
  let quitting: Promise<void> | undefined
  let readyToQuit = false
  app.on('before-quit', (event) => {
    if (readyToQuit) return
    event.preventDefault()
    quitting ??= (async () => {
      try {
        chats.disconnect()
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
