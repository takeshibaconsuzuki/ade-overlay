import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
} from 'electron'
import { CONTROLLER_IPC_CHANNELS } from './ipc-channels'
import { openWorktreesWindow } from './index'

/**
 * Registers the controller role's main-process IPC handlers, exposed to its
 * renderer via the preload bridge. Call once after the app is ready when
 * launching the controller role.
 */
export function registerControllerIpcHandlers(): void {
  ipcMain.handle(CONTROLLER_IPC_CHANNELS.selectRepository, async (event) => {
    const options: OpenDialogOptions = {
      title: 'Select a Git repository',
      properties: ['openDirectory'],
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle(CONTROLLER_IPC_CHANNELS.openWorktrees, () => {
    openWorktreesWindow()
  })

  ipcMain.handle(CONTROLLER_IPC_CHANNELS.closeWindow, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
