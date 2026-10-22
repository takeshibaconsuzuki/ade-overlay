import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ConnectionState, Worktree } from '../../shared/api'
import {
  type PickerApi,
  START_COMMAND_INITIALIZE,
  START_COMMAND_DATA,
  START_COMMAND_WRITE,
  START_COMMAND_RESIZE,
  CONNECTION_STATE_CHANGED,
  WORKTREE_PICKER_INITIALIZE,
  WORKTREE_PICKER_HIDE,
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

let onStartCommandInitialized: ((history: string | null) => void) | undefined
let onStartCommandData: ((data: string) => void) | undefined
ipcRenderer.on(START_COMMAND_INITIALIZE, (_event, history: string | null) => {
  onStartCommandInitialized?.(history)
})
ipcRenderer.on(START_COMMAND_DATA, (_event, data: string) => {
  onStartCommandData?.(data)
})

const api: PickerApi = {
  initializeStartCommand: () => ipcRenderer.send(START_COMMAND_INITIALIZE),
  setOnStartCommandInitializedListener(listener) {
    onStartCommandInitialized = listener
  },
  setOnStartCommandDataListener(listener) {
    onStartCommandData = listener
  },
  writeStartCommand: (data) => ipcRenderer.send(START_COMMAND_WRITE, data),
  resizeStartCommand: (cols, rows) =>
    ipcRenderer.send(START_COMMAND_RESIZE, cols, rows),
  setOnVisibilityChangedListener(listener) {
    onVisibilityChangedListener = listener
  },
  initializeWorktreePicker: () => ipcRenderer.send(WORKTREE_PICKER_INITIALIZE),
  hideWorktreePicker: () => ipcRenderer.send(WORKTREE_PICKER_HIDE),
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
