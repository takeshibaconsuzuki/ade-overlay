export type ConnectionState = 'connecting' | 'connected' | 'retrying' | 'closed'

export interface Worktree {
  path: string
  basename: string
  branchName: string | null
}

export interface ServerMethods {
  getServerInfo(): { name: string }
  refreshWorktrees(): Promise<void>
}

export interface ClientMethods {
  getClientInfo(): { name: string; version: string }
  worktreesChanged(worktrees: Worktree[]): void
}
