export type ConnectionState = 'connecting' | 'connected' | 'retrying' | 'closed'

export interface Worktree {
  path: string
  basename: string
  branchName: string | null
}

export interface VscodeServerStatus {
  path: string
  state: 'stopped' | 'starting' | 'running'
  error?: { id: string; message: string }
  // Authenticated browser route, available once the server is ready.
  browserPath?: string
}

export interface ServerMethods {
  getServerInfo(): { name: string }
  refreshWorktrees(): Promise<void>
  ensureVscodeServer(path: string): void
  clearVscodeServerError(path: string, errorId: string): void
}

export interface ClientMethods {
  getClientInfo(): { name: string; version: string }
  worktreesChanged(worktrees: Worktree[]): void
  vscodeServersChanged(statuses: VscodeServerStatus[]): void
}
