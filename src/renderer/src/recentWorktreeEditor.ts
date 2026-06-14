const RECENT_WORKTREE_EDITOR_KEY = 'ade-overlay:recent-worktree-editor'

export function rememberRecentWorktreeEditor(worktreeId: string): void {
  localStorage.setItem(RECENT_WORKTREE_EDITOR_KEY, worktreeId)
}

export function getRecentWorktreeEditor(): string | null {
  return localStorage.getItem(RECENT_WORKTREE_EDITOR_KEY)
}

export function clearRecentWorktreeEditor(worktreeId: string): void {
  if (getRecentWorktreeEditor() === worktreeId) {
    localStorage.removeItem(RECENT_WORKTREE_EDITOR_KEY)
  }
}
