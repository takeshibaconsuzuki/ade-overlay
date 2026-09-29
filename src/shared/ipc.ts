import type {
  CreateWorktreeInput,
  DeleteWorktreeInput,
  OpenEditorInput,
  SetWorktreeErrorInput,
  WorktreeSnapshot,
} from './companion.ts'

export const companionChannels = {
  state: 'companion:state',
  getState: 'companion:get-state',
  reconnect: 'companion:reconnect',
  refreshWorktrees: 'companion:worktrees:refresh',
  createWorktree: 'companion:worktrees:create',
  deleteWorktree: 'companion:worktrees:delete',
  setWorktreeError: 'companion:worktrees:set-error',
  openEditor: 'companion:editor:open',
} as const

export interface CompanionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  url: string
  error?: string
}

export interface CompanionState {
  status: CompanionStatus
  snapshot: WorktreeSnapshot | null
  loading: boolean
  error: string
}

export interface CompanionAPI {
  getState(): Promise<CompanionState>
  onState(callback: (state: CompanionState) => void): () => void
  reconnect(): Promise<void>
  refreshWorktrees(): Promise<void>
  createWorktree(input: CreateWorktreeInput): Promise<void>
  deleteWorktree(input: DeleteWorktreeInput): Promise<void>
  setWorktreeError(input: SetWorktreeErrorInput): Promise<void>
  openEditor(input: OpenEditorInput): Promise<void>
}
