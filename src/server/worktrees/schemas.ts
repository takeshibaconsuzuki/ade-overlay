import { z } from 'zod/v4'
import { WORKTREE_ID_LENGTH } from './ids'

export const PathSchema = z.string().min(1)

export const AddRepositoryRequest = z.object({
  repositoryPath: PathSchema,
})

export const RemoveRepositoryRequest = z.object({
  mainWorktreePath: PathSchema,
})

export const CreateWorktreeRequest = z.object({
  mainWorktreePath: PathSchema,
  newBranch: z.string().min(1).optional(),
  baseBranch: z.string().min(1),
  worktreePath: PathSchema,
})

export const DeleteWorktreeParams = z.object({
  worktreeId: z.string().length(WORKTREE_ID_LENGTH),
})

export const DeleteWorktreeRequest = z.object({
  deleteBranch: z.boolean().default(false),
})

export const Repository = z.object({
  mainWorktreePath: z.string(),
})

export const Worktree = z.object({
  worktreeId: z.string(),
  path: z.string(),
  mainWorktreePath: z.string(),
  head: z.string().optional(),
  branch: z.string().optional(),
  branchName: z.string().optional(),
  isBare: z.boolean(),
  isDetached: z.boolean(),
  isPrunable: z.boolean(),
  prunableReason: z.string().optional(),
})

export const WorktreeSnapshot = z.object({
  repositories: z.array(Repository),
  worktrees: z.array(Worktree),
})

const WorktreeSnapshotEvent = z.object({
  type: z.literal('snapshot'),
  snapshot: WorktreeSnapshot,
})

export const WorktreeEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('repository-added'),
    repository: Repository,
    snapshot: WorktreeSnapshot,
  }),
  z.object({
    type: z.literal('repository-removed'),
    mainWorktreePath: z.string(),
    snapshot: WorktreeSnapshot,
  }),
  z.object({
    type: z.literal('worktree-created'),
    worktree: Worktree,
    snapshot: WorktreeSnapshot,
  }),
  z.object({
    type: z.literal('worktree-deleted'),
    worktreeId: z.string(),
    branchDeleted: z.boolean(),
    snapshot: WorktreeSnapshot,
  }),
])

export const WorktreeStreamEvent = z.union([
  WorktreeSnapshotEvent,
  WorktreeEvent,
])

export const AddRepositoryResponse = z.object({
  repository: Repository,
  snapshot: WorktreeSnapshot,
})

export const RemoveRepositoryResponse = z.object({
  removed: z.boolean(),
  snapshot: WorktreeSnapshot,
})

export const CreateWorktreeResponse = z.object({
  worktreeId: z.string(),
  worktree: Worktree,
})

export const DeleteWorktreeResponse = z.object({
  deleted: z.boolean(),
  branchDeleted: z.boolean(),
})

export const ErrorResponse = z.object({
  error: z.string(),
  message: z.string(),
})

export type AddRepositoryRequest = z.infer<typeof AddRepositoryRequest>
export type RemoveRepositoryRequest = z.infer<typeof RemoveRepositoryRequest>
export type CreateWorktreeRequest = z.infer<typeof CreateWorktreeRequest>
export type DeleteWorktreeParams = z.infer<typeof DeleteWorktreeParams>
export type DeleteWorktreeRequest = z.infer<typeof DeleteWorktreeRequest>
export type Repository = z.infer<typeof Repository>
export type Worktree = z.infer<typeof Worktree>
export type WorktreeSnapshot = z.infer<typeof WorktreeSnapshot>
export type WorktreeEvent = z.infer<typeof WorktreeEvent>
export type WorktreeStreamEvent = z.infer<typeof WorktreeStreamEvent>
