import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
} from 'electron'
import { type ChooseFilesOptions } from '../api/preload/desktop'
import { MAIN_IPC_CHANNELS } from './ipc-channels'

const windowsWithOpenDialog = new WeakSet<BrowserWindow>()

export function hasOpenNativeDialog(window: BrowserWindow): boolean {
  return windowsWithOpenDialog.has(window)
}

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
      if (window) {
        windowsWithOpenDialog.add(window)
      }
      const result = await (
        window
          ? dialog.showOpenDialog(window, dialogOptions)
          : dialog.showOpenDialog(dialogOptions)
      ).finally(() => {
        if (window) {
          windowsWithOpenDialog.delete(window)
        }
      })

      return result.canceled ? [] : result.filePaths
    },
  )

  ipcMain.handle(MAIN_IPC_CHANNELS.closeWindow, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
