export type ConnectionState = 'connecting' | 'connected' | 'retrying' | 'closed'

export interface WorktreeInfo {
  path: string
  basename: string
  branchName: string | null
}

export interface Worktree extends WorktreeInfo {
  mainWorktreePath: string
  // Remains true through server termination and Git removal. Success removes the
  // worktree from the snapshot; failure clears it and retains a dismissible error.
  deleting: boolean
  // Latest operation failure. Retained across successful operations until explicitly
  // dismissed; a newer failure replaces it. Error IDs protect against stale dismissals.
  error?: { id: string; message: string }
  vscode: VscodeServerStatus
}

export interface VscodeServerStatus {
  path: string
  state: 'stopped' | 'starting' | 'running' | 'stopping'
  // Authenticated browser route, available once the server is ready.
  browserPath?: string
}

export interface ServerMethods {
  getServerInfo(): { name: string }
  refreshWorktrees(): Promise<void>
  // Lifecycle commands acknowledge acceptance, not completion. Validation errors
  // reject the call; subsequent progress and failures arrive in worktreesChanged.
  // Different worktrees run independently. Repeated requests are idempotent;
  // starting a stopping server or a deleting worktree is rejected.
  ensureVscodeServer(path: string): void
  stopVscodeServer(path: string): void
  deleteWorktree(path: string): void
  clearWorktreeError(path: string, errorId: string): void
  writeSettings(content: string): Promise<void>
}

export interface ClientMethods {
  getClientInfo(): { name: string; version: string }
  // Complete authoritative snapshot, also sent on connection. May precede command acknowledgment.
  worktreesChanged(worktrees: Worktree[]): void
  // A complete host document is sent on every connection and change. null suspends sync.
  settingsChanged(content: string | null): void
}
