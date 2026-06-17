import { useWorktreeStream } from '../controller/worktrees'

/**
 * The worktree the user is currently "in". The server owns this as the single
 * source of truth (`selectedWorktreeId`, persisted and replayed in every
 * worktree snapshot); clients only mirror it, so the launcher, chat, and editor
 * can never disagree about which worktree is current.
 */
export function useCurrentWorktreeId(): string | null {
  const { snapshot } = useWorktreeStream()
  return snapshot.selectedWorktreeId ?? null
}
