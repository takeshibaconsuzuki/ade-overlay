import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ConnectionState,
  Worktree,
  VscodeServerStatus,
} from '../../shared/api'
import {
  type DesktopApi,
  CONNECTION_STATE_CHANGED,
  WORKTREE_PICKER_INITIALIZE,
  EDITOR_INITIALIZE,
  WORKTREES_CHANGED,
  WORKTREES_REFRESH,
  VSCODE_SERVERS_CHANGED,
  WORKTREE_OPEN,
  EDITOR_STATE_CHANGED,
  EDITOR_RETRY,
  type EditorState,
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

let onEditorStateChangedListener: ((state: EditorState) => void) | undefined
ipcRenderer.on(
  EDITOR_STATE_CHANGED,
  (_event: IpcRendererEvent, state: EditorState) => {
    onEditorStateChangedListener?.(state)
  },
)

const api: DesktopApi = {
  initializeWorktreePicker: () => ipcRenderer.send(WORKTREE_PICKER_INITIALIZE),
  initializeEditorWindow: () => ipcRenderer.send(EDITOR_INITIALIZE),
  setOnConnectionStateChangedListener(listener) {
    onConnectionStateChangedListener = listener
  },
  setOnWorktreesChangedListener(listener) {
    onWorktreesChangedListener = listener
  },
  refreshWorktrees: () => ipcRenderer.invoke(WORKTREES_REFRESH),
  openWorktree: (path) => ipcRenderer.invoke(WORKTREE_OPEN, path),
  retryEditor: () => ipcRenderer.invoke(EDITOR_RETRY),
  setOnEditorStateChangedListener(listener) {
    onEditorStateChangedListener = listener
  },
  clearVscodeServerError: (path, errorId) =>
    ipcRenderer.invoke(VSCODE_SERVER_CLEAR_ERROR, path, errorId),
  setOnVscodeServersChangedListener(listener) {
    onVscodeServersChangedListener = listener
  },
}

contextBridge.exposeInMainWorld('desktop', api)
