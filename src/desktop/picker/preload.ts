import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ConnectionState, Worktree } from '../../shared/api'
import {
  type PickerApi,
  CONNECTION_STATE_CHANGED,
  WORKTREE_PICKER_INITIALIZE,
  WORKTREE_PICKER_VISIBILITY_CHANGED,
  WORKTREES_CHANGED,
  WORKTREES_REFRESH,
  VSCODE_SERVER_STOP,
  WORKTREE_DELETE,
  WORKTREE_OPEN,
  WORKTREE_CLEAR_ERROR,
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

let onVisibilityChangedListener: ((visible: boolean) => void) | undefined
ipcRenderer.on(
  WORKTREE_PICKER_VISIBILITY_CHANGED,
  (_event: IpcRendererEvent, visible: boolean) => {
    onVisibilityChangedListener?.(visible)
  },
)

const api: PickerApi = {
  setOnVisibilityChangedListener(listener) {
    onVisibilityChangedListener = listener
  },
  initializeWorktreePicker: () => ipcRenderer.send(WORKTREE_PICKER_INITIALIZE),
  setOnConnectionStateChangedListener(listener) {
    onConnectionStateChangedListener = listener
  },
  setOnWorktreesChangedListener(listener) {
    onWorktreesChangedListener = listener
  },
  refreshWorktrees: () => ipcRenderer.invoke(WORKTREES_REFRESH),
  openWorktree: (path) => ipcRenderer.invoke(WORKTREE_OPEN, path),
  clearWorktreeError: (path, errorId) =>
    ipcRenderer.invoke(WORKTREE_CLEAR_ERROR, path, errorId),
  stopVscodeServer: (path) => ipcRenderer.invoke(VSCODE_SERVER_STOP, path),
  deleteWorktree: (path, branchName) =>
    ipcRenderer.invoke(WORKTREE_DELETE, path, branchName),
}

contextBridge.exposeInMainWorld('picker', api)
