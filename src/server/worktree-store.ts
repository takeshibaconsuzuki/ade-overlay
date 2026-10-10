import type { Worktree } from '../shared/api'
import { logger } from '../shared/logger'
import type { Project } from './options'
import { listWorktrees } from './git-utils'

const log = logger.child({ component: 'worktree-store' })

export class WorktreeStore {
  private projects: Project[]
  private worktrees: Worktree[] = []
  private onChangedListener: ((worktrees: Worktree[]) => void) | undefined
  private readonly controller = new AbortController()
  private refreshRequested = false
  private running: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(
    projects: Project[],
    private readonly scan = listWorktrees,
  ) {
    this.projects = structuredClone(projects)
  }

  get snapshot(): Worktree[] {
    return this.worktrees
  }

  setOnChangedListener(
    listener: ((worktrees: Worktree[]) => void) | undefined,
  ): void {
    this.onChangedListener = listener
  }

  setProjects(projects: Project[]): Promise<void> {
    if (this.controller.signal.aborted)
      return Promise.reject(this.controller.signal.reason)
    this.projects = structuredClone(projects)
    return this.queueRefresh()
  }

  queueRefresh(): Promise<void> {
    if (this.controller.signal.aborted)
      return Promise.reject(this.controller.signal.reason)
    this.refreshRequested = true
    this.running ??= Promise.resolve().then(() => this.refresh())
    return this.running
  }

  private async refresh(): Promise<void> {
    try {
      while (this.refreshRequested) {
        this.controller.signal.throwIfAborted()
        this.refreshRequested = false
        log.info({ projectCount: this.projects.length }, 'Refreshing worktrees')
        const worktrees = await this.scan(this.projects, this.controller.signal)
        this.controller.signal.throwIfAborted()
        this.worktrees = worktrees
        log.info({ worktreeCount: worktrees.length }, 'Worktrees refreshed')
        this.onChangedListener?.(worktrees)
      }
    } finally {
      this.running = undefined
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.controller.abort(new Error('Worktree store closed'))
      this.onChangedListener = undefined
      // The scan settles only after all aborted Git commands have terminated.
      this.closing = this.running?.catch(() => {}) ?? Promise.resolve()
    }
    return this.closing
  }
}
