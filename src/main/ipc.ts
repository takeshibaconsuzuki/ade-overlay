import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
} from 'electron'
import { type ChooseFilesOptions } from '../api/preload/desktop'
import { MAIN_IPC_CHANNELS } from './ipc-channels'

/**
 * Registers generic main-process IPC handlers used by multiple app roles.
 */
export function registerMainIpcHandlers(): void {
  ipcMain.handle(
    MAIN_IPC_CHANNELS.chooseFiles,
    async (event, options: ChooseFilesOptions): Promise<string[]> => {
      const dialogOptions: OpenDialogOptions = {
        title: options.title,
        properties: options.allowed.map((kind) =>
          kind === 'd' ? 'openDirectory' : 'openFile',
        ),
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      const result = window
        ? await dialog.showOpenDialog(window, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)

      return result.canceled ? [] : result.filePaths
    },
  )

  ipcMain.handle(MAIN_IPC_CHANNELS.closeWindow, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
