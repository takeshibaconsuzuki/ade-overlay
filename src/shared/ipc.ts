import type {
  WorktreeBranch,
  CreateWorktreeInput,
  WorktreePathTemplates,
  DeleteWorktreeInput,
  WorktreeRef,
  SetWorktreeErrorInput,
  Worktree,
  WorktreeSnapshot,
} from './companion.ts'

export const pickerChannels = {
  hide: 'picker:hide',
  hidden: 'picker:hidden',
} as const

export interface PickerWindowAPI {
  hide(): Promise<void>
  onHidden(callback: () => void): () => void
}

export const companionChannels = {
  state: 'companion:state',
  getState: 'companion:get-state',
  reconnect: 'companion:reconnect',
  refreshWorktrees: 'companion:worktrees:refresh',
  createWorktree: 'companion:worktrees:create',
  getWorktreePathTemplates: 'companion:worktrees:path-templates',
  getWorktreeBranches: 'companion:worktrees:branches',
  deleteWorktree: 'companion:worktrees:delete',
  setWorktreeError: 'companion:worktrees:set-error',
  openEditor: 'companion:editor:open',
  stopEditor: 'companion:editor:stop',
  openBootstrapLog: 'companion:worktrees:bootstrap-log',
} as const

export interface CompanionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  url: string
  error?: string
}

// Desktop main's own data about one worktree. It is never sent to the
// companion or shared with other desktops.
export interface LocalWorktreeState {
  lastOpenedAt?: number
  opening?: boolean
  error?: string
}

// A companion row with this desktop's local state merged in. A local error
// replaces the companion's.
export type DesktopWorktree = Worktree &
  Pick<LocalWorktreeState, 'lastOpenedAt' | 'opening'>

export type DesktopSnapshot = Omit<WorktreeSnapshot, 'worktrees'> & {
  worktrees: DesktopWorktree[]
}

export interface CompanionState {
  status: CompanionStatus
  snapshot: DesktopSnapshot | null
  loading: boolean
  error: string
}

export interface CompanionAPI {
  getState(): Promise<CompanionState>
  onState(callback: (state: CompanionState) => void): () => void
  reconnect(): Promise<void>
  refreshWorktrees(): Promise<void>
  createWorktree(input: CreateWorktreeInput): Promise<void>
  getWorktreePathTemplates(): Promise<WorktreePathTemplates>
  getWorktreeBranches(project: string): Promise<WorktreeBranch[]>
  deleteWorktree(input: DeleteWorktreeInput): Promise<void>
  setWorktreeError(input: SetWorktreeErrorInput): Promise<void>
  openEditor(input: WorktreeRef): Promise<void>
  stopEditor(input: WorktreeRef): Promise<void>
  openBootstrapLog(input: WorktreeRef): Promise<void>
}
