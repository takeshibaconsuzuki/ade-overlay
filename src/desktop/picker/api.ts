import type {
  ConnectionState,
  Worktree,
  VscodeServerStatus,
} from '../../shared/api'

// Worktree-picker renderer → main: requests current connection state, worktrees, and VS Code server statuses after listeners are registered.
export const WORKTREE_PICKER_INITIALIZE = 'worktreePicker:initialize'

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

// Renderer → main: dismisses the identified error without changing the server lifecycle.
export const VSCODE_SERVER_CLEAR_ERROR = 'vscode:clearError'

export interface PickerApi {
  setOnConnectionStateChangedListener(
    listener: ((state: ConnectionState) => void) | undefined,
  ): void
  setOnWorktreesChangedListener(
    listener: ((worktrees: Worktree[]) => void) | undefined,
  ): void
  initializeWorktreePicker(): void
  refreshWorktrees(): Promise<void>
  openWorktree(path: string): Promise<void>
  clearVscodeServerError(path: string, errorId: string): Promise<void>
  setOnVscodeServersChangedListener(
    listener: ((statuses: VscodeServerStatus[]) => void) | undefined,
  ): void
}
