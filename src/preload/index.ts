import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_API_GLOBAL, type DesktopApi } from '../api/preload/desktop'
import { CONTROLLER_IPC_CHANNELS } from '../main/controller/ipc-channels'

/**
 * Narrow privileged API exposed to the renderer. Keep this surface minimal —
 * each method maps to a single main-process IPC handler.
 */
const desktop: DesktopApi = {
  /** Opens a native directory picker; resolves to the chosen path or null. */
  selectRepository: (): Promise<string | null> =>
    ipcRenderer.invoke(CONTROLLER_IPC_CHANNELS.selectRepository),
  /** Opens the worktrees window (focusing it if already open). */
  openWorktrees: (): Promise<void> =>
    ipcRenderer.invoke(CONTROLLER_IPC_CHANNELS.openWorktrees),
}

contextBridge.exposeInMainWorld(DESKTOP_API_GLOBAL, desktop)
