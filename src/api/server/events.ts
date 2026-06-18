/**
 * Single source of truth for worktree change-event names.
 *
 * Lives in `src/api/server`, the shared surface for the HTTP server API: the
 * shared worktree schema builds the Zod union from these names, and the
 * unprivileged renderer registers stream listeners from them.
 *
 * The `snapshot` event is intentionally excluded: it is the initial full-state
 * event, not one of the incremental change events listed here.
 */
export const WORKTREE_EVENT_TYPE = {
  repositoryAdded: 'repository-added',
  repositoryRemoved: 'repository-removed',
  worktreeCreated: 'worktree-created',
  worktreeCreationUpdated: 'worktree-creation-updated',
  worktreeDeleted: 'worktree-deleted',
  worktreeSelected: 'worktree-selected',
} as const

export type WorktreeEventType =
  (typeof WORKTREE_EVENT_TYPE)[keyof typeof WORKTREE_EVENT_TYPE]

/** All change-event names, e.g. for registering stream listeners. */
export const WORKTREE_EVENT_TYPES: readonly WorktreeEventType[] =
  Object.values(WORKTREE_EVENT_TYPE)
