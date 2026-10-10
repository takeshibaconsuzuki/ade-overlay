import type { ConnectionState, Worktree } from '../shared/api'

// Renderer → main: requests initial connection state and worktrees after listeners are registered.
export const INITIALIZE = 'desktop:initialize'
// Main → renderer: delivers the latest worktrees after a server update or initialization.
export const WORKTREES_CHANGED = 'worktrees:changed'
// Renderer → main: invokes the server refresh RPC and returns its completion or failure.
export const WORKTREES_REFRESH = 'worktrees:refresh'
// Main → renderer: reports connection state changes, including disconnects and retries.
export const CONNECTION_STATE_CHANGED = 'connection:stateChanged'

export interface DesktopApi {
  setOnConnectionStateChangedListener(
    listener: ((state: ConnectionState) => void) | undefined,
  ): void
  setOnWorktreesChangedListener(
    listener: ((worktrees: Worktree[]) => void) | undefined,
  ): void
  initialize(): void
  refreshWorktrees(): Promise<void>
}
