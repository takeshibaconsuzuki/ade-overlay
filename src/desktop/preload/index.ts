import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ConnectionState, Worktree } from '../../shared/api'
import {
  type DesktopApi,
  CONNECTION_STATE_CHANGED,
  INITIALIZE,
  WORKTREES_CHANGED,
  WORKTREES_REFRESH,
} from '../api'

let onConnectionStateChangedListener:
  ((state: ConnectionState) => void) | undefined
ipcRenderer.on(
  CONNECTION_STATE_CHANGED,
  (_event: IpcRendererEvent, state: ConnectionState) => {
    onConnectionStateChangedListener?.(state)
  },
)

let onWorktreesChangedListener: ((worktrees: Worktree[]) => void) | undefined
ipcRenderer.on(
  WORKTREES_CHANGED,
  (_event: IpcRendererEvent, worktrees: Worktree[]) => {
    onWorktreesChangedListener?.(worktrees)
  },
)

const api: DesktopApi = {
  initialize: () => ipcRenderer.send(INITIALIZE),
  setOnConnectionStateChangedListener(listener) {
    onConnectionStateChangedListener = listener
  },
  setOnWorktreesChangedListener(listener) {
    onWorktreesChangedListener = listener
  },
  refreshWorktrees: () => ipcRenderer.invoke(WORKTREES_REFRESH),
}

contextBridge.exposeInMainWorld('desktop', api)
