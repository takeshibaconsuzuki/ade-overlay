import type {
  ConnectionState,
  Worktree,
  VscodeServerStatus,
} from '../shared/api'

// Worktree-picker renderer → main: requests current connection state, worktrees, and VS Code server statuses after listeners are registered.
export const WORKTREE_PICKER_INITIALIZE = 'worktreePicker:initialize'
// Editor-window renderer → main: requests current editor presentation state after its listener is registered.
export const EDITOR_INITIALIZE = 'editor:initialize'
// Main → renderer: delivers the latest worktrees after a server update or initialization.
export const WORKTREES_CHANGED = 'worktrees:changed'
// Renderer → main: invokes the server refresh RPC and returns its completion or failure.
export const WORKTREES_REFRESH = 'worktrees:refresh'
// Main → renderer: reports connection state changes, including disconnects and retries.
export const CONNECTION_STATE_CHANGED = 'connection:stateChanged'
// Main → renderer: delivers current VS Code server statuses after an update or initialization.
export const VSCODE_SERVERS_CHANGED = 'vscode:changed'
// Renderer → main: selects a worktree in the editor window and ensures its server is running.
export const WORKTREE_OPEN = 'worktree:open'
// Main → editor-window renderer: delivers current editor presentation state after a change or initialization.
export const EDITOR_STATE_CHANGED = 'editor:stateChanged'
// Editor-window renderer → main: retries opening the selected worktree after a failure. Resolves when the startup request is acknowledged; page loading completes asynchronously. Does nothing unless the selected worktree has failed.
export const EDITOR_RETRY = 'editor:retry'
// Renderer → main: dismisses the identified error without changing the server lifecycle.
export const VSCODE_SERVER_CLEAR_ERROR = 'vscode:clearError'

// Presentation state for the editor window's loading and error UI. Loaded pages are displayed separately.
export interface EditorState {
  title: string
  error?: string
}

export interface DesktopApi {
  setOnConnectionStateChangedListener(
    listener: ((state: ConnectionState) => void) | undefined,
  ): void
  setOnWorktreesChangedListener(
    listener: ((worktrees: Worktree[]) => void) | undefined,
  ): void
  initializeWorktreePicker(): void
  initializeEditorWindow(): void
  refreshWorktrees(): Promise<void>
  openWorktree(path: string): Promise<void>
  retryEditor(): Promise<void>
  setOnEditorStateChangedListener(
    listener: ((state: EditorState) => void) | undefined,
  ): void
  clearVscodeServerError(path: string, errorId: string): Promise<void>
  setOnVscodeServersChangedListener(
    listener: ((statuses: VscodeServerStatus[]) => void) | undefined,
  ): void
}
