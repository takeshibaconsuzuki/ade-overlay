/**
 * Single source of truth for worktree change-event names.
 *
 * Lives in `src/api/server`, the node-free shared surface for the HTTP server
 * API: the server schema (`worktrees/schemas.ts`) builds the Zod union from
 * these names, and the unprivileged renderer registers stream listeners from
 * them. Keep it dependency-free (no `node:*`, no Zod) to preserve that boundary.
 *
 * The `snapshot` event is intentionally excluded: it is the initial full-state
 * event, not one of the incremental change events listed here.
 */
export const WORKTREE_EVENT_TYPE = {
  repositoryAdded: 'repository-added',
  repositoryRemoved: 'repository-removed',
  worktreeCreated: 'worktree-created',
  worktreeDeleted: 'worktree-deleted',
} as const

export type WorktreeEventType =
  (typeof WORKTREE_EVENT_TYPE)[keyof typeof WORKTREE_EVENT_TYPE]

/** All change-event names, e.g. for registering stream listeners. */
export const WORKTREE_EVENT_TYPES: readonly WorktreeEventType[] =
  Object.values(WORKTREE_EVENT_TYPE)
