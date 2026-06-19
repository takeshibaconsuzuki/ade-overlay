import { ipcMain } from 'electron'
import { openWorktreesWindow, setLauncherDormant } from './index'
import { CONTROLLER_IPC_CHANNELS } from './ipc-channels'

/**
 * Registers the controller role's main-process IPC handlers, exposed to its
 * renderer via the preload bridge. Call once after the app is ready when
 * launching the controller role.
 */
export function registerControllerIpcHandlers(): void {
  ipcMain.handle(CONTROLLER_IPC_CHANNELS.openWorktreesWindow, () => {
    openWorktreesWindow()
  })
  ipcMain.handle(CONTROLLER_IPC_CHANNELS.setLauncherDormant, () => {
    setLauncherDormant()
  })
}
