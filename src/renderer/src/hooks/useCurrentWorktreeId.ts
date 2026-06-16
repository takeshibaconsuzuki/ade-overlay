import { useMemo } from 'react'
import { useWorktreeStream } from '../controller/worktrees'
import { getCacheItem, RECENT_WORKTREE_EDITOR_KEY } from '../persistentCache'

/**
 * The worktree the user is currently "in", inferred the same way across the
 * launcher and chat windows: prefer the most recently switched-to live editor
 * session (the server emits a fresh `lastSwitchAt` on every switch), falling
 * back to the remembered worktree from the persistent cache when no session is
 * live (e.g. a fresh app start).
 */
export function useCurrentWorktreeId(): string | null {
  const { snapshot } = useWorktreeStream()

  return useMemo(
    () =>
      snapshot.selectedWorktreeId ?? getCacheItem(RECENT_WORKTREE_EDITOR_KEY),
    [snapshot.selectedWorktreeId],
  )
}
