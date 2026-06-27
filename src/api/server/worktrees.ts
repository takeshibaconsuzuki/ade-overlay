import { z } from 'zod/v4'
import { WORKTREE_EVENT_TYPE } from './events'
import { defineSseEvents, SSE_SNAPSHOT_EVENT } from './sse'

export const REPOSITORIES_PATH = '/repositories'
export const REPOSITORY_BRANCHES_PATH = `${REPOSITORIES_PATH}/branches`
export const WORKTREES_PATH = '/worktrees'
export const WORKTREE_PATH = `${WORKTREES_PATH}/:worktreeId`
export const WORKTREE_OPEN_PATH = `${WORKTREE_PATH}/open`
export const WORKTREE_CREATION_LOGS_OPEN_PATH = `${WORKTREE_PATH}/creation-logs/open`
export const WORKTREE_DISMISS_CREATION_PATH = `${WORKTREE_PATH}/dismiss-creation`
export const WORKTREE_PATH_PREVIEW_PATH = `${WORKTREES_PATH}/path-preview`

export const PathSchema = z.string().min(1)
export const WorktreeId = z.string().min(1)

export function worktreeOpenPath(worktreeId: string): string {
  return `${WORKTREES_PATH}/${encodeURIComponent(worktreeId)}/open`
}

export function worktreeCreationLogsOpenPath(worktreeId: string): string {
  return `${WORKTREES_PATH}/${encodeURIComponent(worktreeId)}/creation-logs/open`
}

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
  bootstrap: z.boolean().default(false),
})

export const PreviewWorktreePathRequest = z.object({
  mainWorktreePath: PathSchema,
  newBranch: z.string().min(1).optional(),
  baseBranch: z.string().min(1),
})

export const ListBranchesRequest = z.object({
  mainWorktreePath: PathSchema,
})

export const DeleteWorktreeParams = z.object({
  worktreeId: WorktreeId,
})

export const DeleteWorktreeRequest = z.object({
  deleteBranch: z.boolean().default(false),
  force: z.boolean().default(false),
})

export const WorktreeIdParams = z.object({
  worktreeId: WorktreeId,
})

export const OpenWorktreeRequest = WorktreeIdParams

export const Repository = z.object({
  mainWorktreePath: z.string(),
  bootstrapCommand: z.string().optional(),
})

export const WorktreeCreationState = z.enum([
  'creating',
  'bootstrapping',
  'ready',
  'failed',
])

export const Worktree = z.object({
  worktreeId: WorktreeId,
  name: z.string(),
  path: z.string(),
  mainWorktreePath: z.string(),
  isMain: z.boolean(),
  head: z.string().optional(),
  branch: z.string().optional(),
  branchName: z.string().optional(),
  isBare: z.boolean(),
  isDetached: z.boolean(),
  isPrunable: z.boolean(),
  prunableReason: z.string().optional(),
  creationState: WorktreeCreationState.default('ready'),
  creationError: z.string().optional(),
  hasCreationLogs: z.boolean().default(false),
  isOpenable: z.boolean().default(true),
})

export const WorktreeSnapshot = z.object({
  repositories: z.array(Repository),
  worktrees: z.array(Worktree),
  selectedWorktreeId: WorktreeId.optional(),
})

const RepositoryAddedEvent = z.object({
  type: z.literal(WORKTREE_EVENT_TYPE.repositoryAdded),
  repository: Repository,
  snapshot: WorktreeSnapshot,
})

const RepositoryRemovedEvent = z.object({
  type: z.literal(WORKTREE_EVENT_TYPE.repositoryRemoved),
  mainWorktreePath: z.string(),
  snapshot: WorktreeSnapshot,
})

const WorktreeCreatedEvent = z.object({
  type: z.literal(WORKTREE_EVENT_TYPE.worktreeCreated),
  worktree: Worktree,
  snapshot: WorktreeSnapshot,
})

const WorktreeCreationUpdatedEvent = z.object({
  type: z.literal(WORKTREE_EVENT_TYPE.worktreeCreationUpdated),
  worktreeId: WorktreeId,
  snapshot: WorktreeSnapshot,
})

const WorktreeDeletedEvent = z.object({
  type: z.literal(WORKTREE_EVENT_TYPE.worktreeDeleted),
  worktreeId: WorktreeId,
  branchDeleted: z.boolean(),
  snapshot: WorktreeSnapshot,
})

const WorktreeSelectedEvent = z.object({
  type: z.literal(WORKTREE_EVENT_TYPE.worktreeSelected),
  worktreeId: WorktreeId,
  snapshot: WorktreeSnapshot,
})

export const WorktreeEvent = z.discriminatedUnion('type', [
  RepositoryAddedEvent,
  RepositoryRemovedEvent,
  WorktreeCreatedEvent,
  WorktreeCreationUpdatedEvent,
  WorktreeDeletedEvent,
  WorktreeSelectedEvent,
])

export const WorktreeSseEvents = defineSseEvents({
  [SSE_SNAPSHOT_EVENT]: WorktreeSnapshot,
  [WORKTREE_EVENT_TYPE.repositoryAdded]: RepositoryAddedEvent,
  [WORKTREE_EVENT_TYPE.repositoryRemoved]: RepositoryRemovedEvent,
  [WORKTREE_EVENT_TYPE.worktreeCreated]: WorktreeCreatedEvent,
  [WORKTREE_EVENT_TYPE.worktreeCreationUpdated]: WorktreeCreationUpdatedEvent,
  [WORKTREE_EVENT_TYPE.worktreeDeleted]: WorktreeDeletedEvent,
  [WORKTREE_EVENT_TYPE.worktreeSelected]: WorktreeSelectedEvent,
})

export const WorktreeStreamResponse = z
  .string()
  .describe('Server-sent worktree snapshot and change events.')

export const AddRepositoryResponse = z.object({
  repository: Repository,
  snapshot: WorktreeSnapshot,
})

export const RemoveRepositoryResponse = z.object({
  removed: z.boolean(),
  snapshot: WorktreeSnapshot,
})

export const CreateWorktreeResponse = z.object({
  worktreeId: WorktreeId,
  worktree: Worktree,
})

export const PreviewWorktreePathResponse = z.object({
  worktreePath: z.string(),
})

export const ListBranchesResponse = z.object({
  branches: z.array(z.string()),
})

export const DeleteWorktreeResponse = z.object({
  deleted: z.boolean(),
  branchDeleted: z.boolean(),
})

export const DismissCreationErrorResponse = z.object({
  snapshot: WorktreeSnapshot,
})

export const OpenWorktreeResponse = z.object({
  worktreeId: WorktreeId,
  url: z.string(),
  editorAlreadyStarted: z.boolean(),
})

export const ErrorResponse = z.object({
  error: z.string(),
  message: z.string(),
})

export type AddRepositoryRequest = z.infer<typeof AddRepositoryRequest>
export type RemoveRepositoryRequest = z.infer<typeof RemoveRepositoryRequest>
export type CreateWorktreeRequest = z.infer<typeof CreateWorktreeRequest>
export type PreviewWorktreePathRequest = z.infer<
  typeof PreviewWorktreePathRequest
>
export type ListBranchesRequest = z.infer<typeof ListBranchesRequest>
export type DeleteWorktreeParams = z.infer<typeof DeleteWorktreeParams>
export type DeleteWorktreeRequest = z.infer<typeof DeleteWorktreeRequest>
export type WorktreeId = z.infer<typeof WorktreeId>
export type WorktreeIdParams = z.infer<typeof WorktreeIdParams>
export type OpenWorktreeRequest = z.infer<typeof OpenWorktreeRequest>
export type Repository = z.infer<typeof Repository>
export type Worktree = z.infer<typeof Worktree>
export type WorktreeCreationState = z.infer<typeof WorktreeCreationState>
export type WorktreeSnapshot = z.infer<typeof WorktreeSnapshot>
export type WorktreeEvent = z.infer<typeof WorktreeEvent>
export type WorktreeSseEvents = typeof WorktreeSseEvents
export type OpenWorktreeResponse = z.infer<typeof OpenWorktreeResponse>
