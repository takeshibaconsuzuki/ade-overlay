import { EventEmitter } from 'node:events'
import type { CompanionClient } from './companion-client.ts'
import type {
  CompanionState as DesktopCompanionState,
  CompanionStatus,
} from '../shared/ipc.ts'
import type {
  CreateWorktreeInput,
  DeleteWorktreeInput,
  SetWorktreeErrorInput,
  WorktreeSnapshot,
} from '../shared/companion.ts'

// The transport owns connections; this owner accepts their snapshots once for
// both retained editors and the picker, independently of renderer lifetimes.
export class CompanionState extends EventEmitter<{
  changed: [DesktopCompanionState]
  snapshot: [WorktreeSnapshot]
}> {
  private current: DesktopCompanionState
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
      if (status.state === 'connected')
        void this.load(() => client.listWorktrees())
      else this.emit('changed', this.current)
    })
    client.on('worktreesUpdated', (snapshot) => this.accept(snapshot))
  }

  getCurrent(): DesktopCompanionState {
    return this.current
  }

  refreshWorktrees(): Promise<void> {
    return this.load(() => this.client.refreshWorktrees())
  }

  createWorktree(input: CreateWorktreeInput): Promise<void> {
    return this.applyReply(() => this.client.createWorktree(input))
  }

  deleteWorktree(input: DeleteWorktreeInput): Promise<void> {
    return this.applyReply(() => this.client.deleteWorktree(input))
  }

  setWorktreeError(input: SetWorktreeErrorInput): Promise<void> {
    return this.applyReply(() => this.client.setWorktreeError(input))
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
    this.emit('snapshot', snapshot)
    this.emit('changed', this.current)
  }

  private async load(request: () => Promise<WorktreeSnapshot>): Promise<void> {
    const id = ++this.loadRequest
    const { status } = this.current
    this.current = { ...this.current, loading: true, error: '' }
    this.emit('changed', this.current)
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
        this.emit('changed', this.current)
      }
    }
  }
}
