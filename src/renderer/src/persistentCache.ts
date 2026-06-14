export const RECENT_WORKTREE_EDITOR_KEY = 'ade-overlay:recent-worktree-editor'
export const RECENT_WORKTREE_PROJECT_KEY = 'ade-overlay:recent-worktree-project'

export function setCacheItem(key: string, value: string): void {
  localStorage.setItem(key, value)
}

export function getCacheItem(key: string): string | null {
  return localStorage.getItem(key)
}

export function deleteCacheItem(key: string, value?: string): void {
  if (value === undefined || getCacheItem(key) === value) {
    localStorage.removeItem(key)
  }
}
