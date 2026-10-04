import { EventEmitter } from 'node:events'
import type { CompanionClient } from './companion-client.ts'
import type {
  CompanionState as DesktopCompanionState,
  CompanionStatus,
  LocalWorktreeState,
} from '../shared/ipc.ts'
import type {
  CreateWorktreeInput,
  DeleteWorktreeInput,
  WorktreeRef,
  SetWorktreeErrorInput,
  WorktreeSnapshot,
} from '../shared/companion.ts'

type AcceptedState = Omit<DesktopCompanionState, 'snapshot'> & {
  snapshot: WorktreeSnapshot | null
}
// Each open in progress has its own token. A worktree is opening until all of
// them end, so a repeated open cannot end one whose page is still loading.
type LocalState = Omit<LocalWorktreeState, 'opening'> & {
  opening?: Set<object>
}

function localKey({ project, path }: WorktreeRef): string {
  return JSON.stringify([project, path])
}

// The transport owns connections; this owner accepts their snapshots once for
// both retained editors and the picker, independently of renderer lifetimes.
// It also owns this desktop's per-worktree state and publishes both together.
export class CompanionState extends EventEmitter<{
  changed: [DesktopCompanionState]
  snapshot: [WorktreeSnapshot]
}> {
  private current: AcceptedState
  private readonly local = new Map<string, LocalState>()
  private lastOpenedAt = 0
  private loadRequest = 0
  private readonly client: CompanionClient

  constructor(client: CompanionClient) {
    super()
    this.client = client
    this.current = {
      status: client.getStatus(),
      snapshot: null,
      loading: false,
      error: '',
    }
    client.on('status', (status) => {
      this.loadRequest++
      this.current = { status, snapshot: null, loading: false, error: '' }
      // Recency outlives a connection; opens and their failures do not.
      for (const state of this.local.values()) {
        state.opening = undefined
        state.error = undefined
      }
      if (status.state === 'connected')
        void this.load(() => client.companionListWorktrees())
      else this.changed()
    })
    client.on('desktopUpdateWorktrees', (snapshot) => this.accept(snapshot))
  }

  getCurrent(): DesktopCompanionState {
    const { snapshot } = this.current
    return {
      ...this.current,
      snapshot: snapshot && {
        ...snapshot,
        worktrees: snapshot.worktrees.map((worktree) => {
          const state = this.local.get(localKey(worktree))
          return {
            ...worktree,
            ...(state?.lastOpenedAt && { lastOpenedAt: state.lastOpenedAt }),
            ...(state?.opening?.size && { opening: true }),
            ...(state?.error && { error: state.error }),
          }
        }),
      },
    }
  }

  private changed(): void {
    this.emit('changed', this.getCurrent())
  }

  // Every open, from any source, starts here. The returned function ends it,
  // keeping a failure this desktop observed as the row's local error. An open
  // from before a new connection ends nothing.
  startOpen(input: WorktreeRef): (error?: string) => void {
    const key = localKey(input)
    const open = {}
    const previous = this.local.get(key)
    this.lastOpenedAt = Math.max(Date.now(), this.lastOpenedAt + 1)
    this.local.set(key, {
      ...previous,
      lastOpenedAt: this.lastOpenedAt,
      opening: (previous?.opening ?? new Set()).add(open),
    })
    this.changed()
    return (error) => {
      const state = this.local.get(key)
      if (!state?.opening?.delete(open)) return
      if (error) state.error = error
      this.changed()
    }
  }

  // Holds a failure only this desktop observed; no error clears it.
  setLocalError(input: WorktreeRef, error?: string): void {
    const key = localKey(input)
    const state = this.local.get(key)
    if ((state?.error ?? '') === (error ?? '')) return
    this.local.set(key, { ...state, error: error || undefined })
    this.changed()
  }

  // Runs a request for one row and keeps its failure on that row.
  async rowRequest(
    input: WorktreeRef,
    request: () => Promise<unknown>,
  ): Promise<void> {
    const { status } = this.current
    try {
      await request()
    } catch (error) {
      if (status === this.current.status)
        this.setLocalError(
          input,
          error instanceof Error ? error.message : String(error),
        )
    }
  }

  refreshWorktrees(): Promise<void> {
    return this.load(() => this.client.companionRefreshWorktrees())
  }

  createWorktree(input: CreateWorktreeInput): Promise<void> {
    return this.applyReply(() => this.client.companionCreateWorktree(input))
  }

  deleteWorktree(input: DeleteWorktreeInput): Promise<void> {
    return this.applyReply(() => this.client.companionDeleteWorktree(input))
  }

  setWorktreeError(input: SetWorktreeErrorInput): Promise<void> {
    return this.applyReply(() => this.client.companionSetWorktreeError(input))
  }

  stopEditor(input: WorktreeRef): Promise<void> {
    return this.applyReply(() => this.client.companionStopEditorServer(input))
  }

  private async applyReply(
    request: () => Promise<WorktreeSnapshot>,
  ): Promise<void> {
    // A status transition replaces this identity, invalidating replies from
    // earlier connections even when the server's revision counter resets.
    const { status } = this.current
    this.accept(await request(), status)
  }

  private accept(
    snapshot: WorktreeSnapshot,
    status: CompanionStatus = this.current.status,
  ): void {
    if (
      status !== this.current.status ||
      status.state !== 'connected' ||
      snapshot.revision <= (this.current.snapshot?.revision ?? -1)
    )
      return
    this.current = { ...this.current, snapshot }
    const present = new Set(snapshot.worktrees.map(localKey))
    for (const [key, state] of this.local)
      if (!present.has(key) && !state.opening?.size) this.local.delete(key)
    this.emit('snapshot', snapshot)
    this.changed()
  }

  private async load(request: () => Promise<WorktreeSnapshot>): Promise<void> {
    const id = ++this.loadRequest
    const { status } = this.current
    this.current = { ...this.current, loading: true, error: '' }
    this.changed()
    try {
      await this.applyReply(request)
    } catch (error) {
      if (status === this.current.status && id === this.loadRequest)
        this.current = {
          ...this.current,
          error: error instanceof Error ? error.message : String(error),
        }
    } finally {
      if (status === this.current.status && id === this.loadRequest) {
        this.current = { ...this.current, loading: false }
        this.changed()
      }
    }
  }
}
