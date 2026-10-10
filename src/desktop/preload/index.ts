import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ConnectionState,
  Worktree,
  VscodeServerStatus,
} from '../../shared/api'
import {
  type DesktopApi,
  CONNECTION_STATE_CHANGED,
  INITIALIZE,
  WORKTREES_CHANGED,
  WORKTREES_REFRESH,
  VSCODE_SERVERS_CHANGED,
  VSCODE_SERVER_ENSURE,
  VSCODE_SERVER_CLEAR_ERROR,
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

let onVscodeServersChangedListener:
  ((statuses: VscodeServerStatus[]) => void) | undefined
ipcRenderer.on(
  VSCODE_SERVERS_CHANGED,
  (_event: IpcRendererEvent, statuses: VscodeServerStatus[]) => {
    onVscodeServersChangedListener?.(statuses)
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
  ensureVscodeServer: (path) => ipcRenderer.invoke(VSCODE_SERVER_ENSURE, path),
  clearVscodeServerError: (path, errorId) =>
    ipcRenderer.invoke(VSCODE_SERVER_CLEAR_ERROR, path, errorId),
  setOnVscodeServersChangedListener(listener) {
    onVscodeServersChangedListener = listener
  },
}

contextBridge.exposeInMainWorld('desktop', api)
