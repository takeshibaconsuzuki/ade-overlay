import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_API_GLOBAL, type DesktopApi } from '../api/preload/desktop'
import { CONTROLLER_IPC_CHANNELS } from '../main/controller/ipc-channels'
import { MAIN_IPC_CHANNELS } from '../main/ipc-channels'

/**
 * Narrow privileged API exposed to the renderer. Keep this surface minimal —
 * each method maps to a single main-process IPC handler.
 */
const desktop: DesktopApi = {
  /** Opens a native file picker; resolves to the chosen paths. */
  chooseFiles: (options): Promise<string[]> =>
    ipcRenderer.invoke(MAIN_IPC_CHANNELS.chooseFiles, options),
  /** Opens the worktrees window (focusing it if already open). */
  openWorktreesWindow: (): Promise<void> =>
    ipcRenderer.invoke(CONTROLLER_IPC_CHANNELS.openWorktreesWindow),
  /** Closes the window that invokes this (used by the custom titlebar). */
  closeWindow: (): Promise<void> =>
    ipcRenderer.invoke(MAIN_IPC_CHANNELS.closeWindow),
}

contextBridge.exposeInMainWorld(DESKTOP_API_GLOBAL, desktop)
