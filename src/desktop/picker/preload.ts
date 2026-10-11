import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ConnectionState,
  Worktree,
  VscodeServerStatus,
} from '../../shared/api'
import {
  type PickerApi,
  CONNECTION_STATE_CHANGED,
  WORKTREE_PICKER_INITIALIZE,
  WORKTREES_CHANGED,
  WORKTREES_REFRESH,
  VSCODE_SERVERS_CHANGED,
  WORKTREE_OPEN,
  VSCODE_SERVER_CLEAR_ERROR,
} from './api'

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

const api: PickerApi = {
  initializeWorktreePicker: () => ipcRenderer.send(WORKTREE_PICKER_INITIALIZE),
  setOnConnectionStateChangedListener(listener) {
    onConnectionStateChangedListener = listener
  },
  setOnWorktreesChangedListener(listener) {
    onWorktreesChangedListener = listener
  },
  refreshWorktrees: () => ipcRenderer.invoke(WORKTREES_REFRESH),
  openWorktree: (path) => ipcRenderer.invoke(WORKTREE_OPEN, path),
  clearVscodeServerError: (path, errorId) =>
    ipcRenderer.invoke(VSCODE_SERVER_CLEAR_ERROR, path, errorId),
  setOnVscodeServersChangedListener(listener) {
    onVscodeServersChangedListener = listener
  },
}

contextBridge.exposeInMainWorld('picker', api)
