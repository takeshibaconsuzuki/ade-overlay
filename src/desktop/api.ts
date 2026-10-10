import type {
  ConnectionState,
  Worktree,
  VscodeServerStatus,
} from '../shared/api'

// Renderer → main: requests current connection state, worktrees, and VS Code server statuses after listeners are registered.
export const INITIALIZE = 'desktop:initialize'
// Main → renderer: delivers the latest worktrees after a server update or initialization.
export const WORKTREES_CHANGED = 'worktrees:changed'
// Renderer → main: invokes the server refresh RPC and returns its completion or failure.
export const WORKTREES_REFRESH = 'worktrees:refresh'
// Main → renderer: reports connection state changes, including disconnects and retries.
export const CONNECTION_STATE_CHANGED = 'connection:stateChanged'
// Main → renderer: delivers current VS Code server statuses after an update or initialization.
export const VSCODE_SERVERS_CHANGED = 'vscode:changed'
// Renderer → main: asynchronously acknowledges a launch request or rejects it; readiness arrives through status updates. Different worktrees can start concurrently.
export const VSCODE_SERVER_ENSURE = 'vscode:ensure'
// Renderer → main: dismisses the identified error without changing the server lifecycle.
export const VSCODE_SERVER_CLEAR_ERROR = 'vscode:clearError'

export interface DesktopApi {
  setOnConnectionStateChangedListener(
    listener: ((state: ConnectionState) => void) | undefined,
  ): void
  setOnWorktreesChangedListener(
    listener: ((worktrees: Worktree[]) => void) | undefined,
  ): void
  initialize(): void
  refreshWorktrees(): Promise<void>
  ensureVscodeServer(path: string): Promise<void>
  clearVscodeServerError(path: string, errorId: string): Promise<void>
  setOnVscodeServersChangedListener(
    listener: ((statuses: VscodeServerStatus[]) => void) | undefined,
  ): void
}
