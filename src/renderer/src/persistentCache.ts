export const RECENT_WORKTREE_PROJECT_KEY = 'ade-overlay:recent-worktree-project'

export function setCacheItem(key: string, value: string): void {
  localStorage.setItem(key, value)
}

export function getCacheItem(key: string): string | null {
  return localStorage.getItem(key)
}
