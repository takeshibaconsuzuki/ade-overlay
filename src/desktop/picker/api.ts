import type { ConnectionState, Worktree } from '../../shared/api'

// Worktree-picker renderer → main: requests current connection state and worktrees after listeners are registered.
export const WORKTREE_PICKER_INITIALIZE = 'worktreePicker:initialize'

// Worktree-picker renderer → main: ends the picker session and relinquishes window focus.
export const WORKTREE_PICKER_HIDE = 'worktreePicker:hide'

// Main → renderer: starts or ends a picker session when its window is shown or hidden.
export const WORKTREE_PICKER_VISIBILITY_CHANGED =
  'worktreePicker:visibilityChanged'

// Main → renderer: delivers the latest worktrees after a server update or initialization.
export const WORKTREES_CHANGED = 'worktrees:changed'

// Renderer → main: invokes the server refresh RPC and returns its completion or failure.
export const WORKTREES_REFRESH = 'worktrees:refresh'

// Main → renderer: reports connection state changes, including disconnects and retries.
export const CONNECTION_STATE_CHANGED = 'connection:stateChanged'

// Renderer → main: selects a worktree in the editor window and ensures its server is running.
export const WORKTREE_OPEN = 'worktree:open'

// Renderer → main: dismisses the identified error without changing the worktree or server lifecycle.
export const WORKTREE_CLEAR_ERROR = 'worktree:clearError'

// Renderer → main: requests server termination and resolves when accepted. Progress and failures arrive through worktree updates. Pages persist and dispose independently in response to server broadcasts.
export const VSCODE_SERVER_STOP = 'vscode:stop'

// Renderer → main: confirms deletion, then requests it from the server. Resolves on cancellation or accepted deletion; rejects invalid requests. Progress and failures arrive through worktree updates. Pages follow server broadcasts.
export const WORKTREE_DELETE = 'worktree:delete'

// The desktop owns the terminal; renderer initialization replays recent output.
export const START_COMMAND_INITIALIZE = 'startCommand:initialize'
export const START_COMMAND_DATA = 'startCommand:data'
export const START_COMMAND_WRITE = 'startCommand:write'
export const START_COMMAND_RESIZE = 'startCommand:resize'

export interface PickerApi {
  initializeStartCommand(): void
  setOnStartCommandInitializedListener(
    listener: ((history: string | null) => void) | undefined,
  ): void
  setOnStartCommandDataListener(
    listener: ((data: string) => void) | undefined,
  ): void
  writeStartCommand(data: string): void
  resizeStartCommand(cols: number, rows: number): void
  setOnVisibilityChangedListener(
    listener: ((visible: boolean) => void) | undefined,
  ): void
  setOnConnectionStateChangedListener(
    listener: ((state: ConnectionState) => void) | undefined,
  ): void
  setOnWorktreesChangedListener(
    listener: ((worktrees: Worktree[]) => void) | undefined,
  ): void
  initializeWorktreePicker(): void
  hideWorktreePicker(): void
  refreshWorktrees(): Promise<void>
  openWorktree(path: string): Promise<void>
  clearWorktreeError(path: string, errorId: string): Promise<void>
  stopVscodeServer(path: string): Promise<void>
  deleteWorktree(path: string, branchName?: string): Promise<void>
}
