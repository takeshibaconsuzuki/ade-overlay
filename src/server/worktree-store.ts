import { randomUUID } from 'node:crypto'
import type { Worktree } from '../shared/api'
import { logger } from '../shared/logger'
import type { Project } from './options'
import {
  GitWorktreeDiscovery,
  type DiscoveredWorktree,
  type WorktreeDiscovery,
} from './git-utils'
import type { VscodeServer, VscodeServerFactory } from './vscode-server'
import type { VscodeProxyTargets } from './vscode-proxy'
import { vscodeBasePath } from './vscode-route'
import { pathKey } from './path-key'

const log = logger.child({ component: 'worktree-store' })

interface Entry {
  metadata: DiscoveredWorktree
  server?: VscodeServer
  // Retained so project removal and shutdown can await an accepted deletion.
  deleting?: Promise<void>
  error?: Worktree['error']
}

export class WorktreeStore implements VscodeProxyTargets {
  private projects: Project[]
  private readonly entries = new Map<string, Entry>()
  // Removed entries no longer appear in snapshots, but shutdown still awaits their cleanup.
  private readonly cleanupTasks = new Set<Promise<void>>()
  private onChangedListener: ((worktrees: Worktree[]) => void) | undefined
  private readonly controller = new AbortController()
  private pending: Promise<void> = Promise.resolve()
  private refreshRequested = false
  private refreshing: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(
    projects: Project[],
    private readonly servers: VscodeServerFactory,
    private readonly discovery: WorktreeDiscovery = new GitWorktreeDiscovery(),
  ) {
    this.projects = structuredClone(projects)
  }

  get snapshot(): Worktree[] {
    return [...this.entries.values()].map(
      ({ metadata, server, deleting, error }) => ({
        path: metadata.path,
        basename: metadata.basename,
        branchName: metadata.branchName,
        mainWorktreePath: metadata.mainWorktreePath,
        deleting: !!deleting,
        error: error && { ...error },
        vscode: server?.snapshot ?? { path: metadata.path, state: 'stopped' },
      }),
    )
  }

  getTarget(basePath: string): string | undefined {
    const entry = this.entries.get(basePath)
    return entry?.deleting ? undefined : entry?.server?.target
  }

  setOnChangedListener(
    listener: ((worktrees: Worktree[]) => void) | undefined,
  ): void {
    this.onChangedListener = listener
  }

  private publish(): void {
    if (!this.controller.signal.aborted) this.onChangedListener?.(this.snapshot)
  }

  private validateProjects(projects: Project[]): void {
    const keys = projects.map((project) => pathKey(project.mainWorktreePath))
    if (new Set(keys).size !== keys.length)
      throw new Error('Duplicate project mainWorktreePath')
  }

  // Only configuration changes and discovery are serialized. Worktree starts, stops,
  // and deletions run independently of this queue and of other worktrees.
  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.controller.signal.aborted)
      return Promise.reject(this.controller.signal.reason)
    const result = this.pending.then(() => {
      this.controller.signal.throwIfAborted()
      return operation()
    })
    this.pending = result.catch(() => {})
    return result
  }

  setProjects(projects: Project[]): Promise<void> {
    const next = structuredClone(projects)
    return this.enqueue(async () => {
      this.validateProjects(next)
      this.projects = next
      const retained = new Set(
        next.map((project) => pathKey(project.mainWorktreePath)),
      )
      const removed = [...this.entries.values()].filter(
        (entry) => !retained.has(pathKey(entry.metadata.projectPath)),
      )
      // Removal is authoritative immediately. Cleanup is best-effort and must not
      // delay client disposal, discovery, or subsequent configuration changes.
      // Re-adding a project before its removal cleanup finishes is unsupported.
      for (const entry of removed)
        this.entries.delete(vscodeBasePath(entry.metadata.path))
      this.publish()
      for (const entry of removed) {
        const cleanup = Promise.allSettled([
          entry.deleting,
          entry.server?.stop(),
        ])
          .then((results) => {
            for (const result of results) {
              if (result.status === 'rejected')
                log.error(
                  { err: result.reason, path: entry.metadata.path },
                  'Unable to clean up removed project worktree',
                )
            }
          })
          .finally(() => this.cleanupTasks.delete(cleanup))
        this.cleanupTasks.add(cleanup)
      }
      // Explicit removals take effect even when discovery of the remaining projects fails.
      await this.refresh()
    })
  }

  queueRefresh(): Promise<void> {
    if (this.controller.signal.aborted)
      return Promise.reject(this.controller.signal.reason)
    this.refreshRequested = true
    this.refreshing ??= this.enqueue(async () => {
      while (this.refreshRequested) {
        this.refreshRequested = false
        await this.refresh()
      }
    }).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async refresh(): Promise<void> {
    this.controller.signal.throwIfAborted()
    this.validateProjects(this.projects)
    const before = new Map(this.entries)
    const found = await this.discovery.scan(
      this.projects,
      this.controller.signal,
    )
    this.controller.signal.throwIfAborted()
    const next = new Map(
      found.map((metadata) => [vscodeBasePath(metadata.path), metadata]),
    )
    if (next.size !== found.length)
      throw new Error('Worktree discovered in multiple projects')
    // A scan may finish after an accepted deletion. Never recreate the removed entry.
    for (const [key, entry] of before) {
      if (this.entries.get(key) !== entry) next.delete(key)
    }
    for (const [key, entry] of this.entries) {
      // Git may already have removed the directory while deletion is still completing.
      if (entry.deleting) continue
      if (!next.has(key))
        throw new Error(
          `Registered worktree disappeared outside ADE: ${entry.metadata.path}`,
        )
      if (
        pathKey(next.get(key)!.mainWorktreePath) !==
        pathKey(entry.metadata.mainWorktreePath)
      )
        throw new Error(
          `Worktree changed project ownership: ${entry.metadata.path}`,
        )
    }
    for (const [key, metadata] of next) {
      const entry = this.entries.get(key)
      if (entry?.deleting) continue
      if (entry) entry.metadata = { ...metadata }
      else this.entries.set(key, { metadata: { ...metadata } })
    }
    log.info({ worktreeCount: this.entries.size }, 'Worktrees refreshed')
    this.publish()
  }

  private entry(path: string): Entry {
    this.controller.signal.throwIfAborted()
    const entry = this.entries.get(vscodeBasePath(path))
    if (!entry) throw new Error('Unknown worktree')
    if (
      !this.projects.some(
        (project) =>
          pathKey(project.mainWorktreePath) ===
          pathKey(entry.metadata.projectPath),
      )
    )
      throw new Error('Project has been removed')
    return entry
  }

  ensureVscodeServer(path: string, serverUrl: string): void {
    const entry = this.entry(path)
    if (entry.deleting) throw new Error('Worktree is being deleted')
    entry.server ??= this.servers.create(entry.metadata.path, (error) => {
      if (error) this.recordError(entry, error)
      this.publish()
    })
    entry.server.ensure(serverUrl)
  }

  private recordError(entry: Entry, error: unknown): void {
    entry.error = {
      id: randomUUID(),
      message: error instanceof Error ? error.message : String(error),
    }
    log.error(
      { err: error, path: entry.metadata.path },
      'Worktree operation failed',
    )
  }

  clearWorktreeError(path: string, errorId: string): void {
    const entry = this.entry(path)
    if (entry.error?.id !== errorId) return
    entry.error = undefined
    this.publish()
  }

  // Acknowledge acceptance without waiting for termination. The server publishes its
  // stopping/stopped state and any failure; repeated stops share its existing promise.
  stopVscodeServer(path: string): void {
    const entry = this.entry(path)
    if (entry.deleting) return
    // The server reports failures through its change callback before rejecting.
    void entry.server?.stop().catch(() => {})
  }

  // Deletion is independent per worktree. Repeated requests are idempotent; starting
  // this worktree is rejected until deletion fails or removes it from the snapshot.
  deleteWorktree(path: string, branchName?: string): void {
    const entry = this.entry(path)
    if (
      pathKey(entry.metadata.path) === pathKey(entry.metadata.mainWorktreePath)
    )
      throw new Error(
        'The main worktree cannot be deleted; remove its project instead',
      )
    if (entry.deleting) return
    if (
      branchName !== undefined &&
      (!branchName || branchName !== entry.metadata.branchName)
    )
      throw new Error('Worktree branch changed; refresh and try again')
    entry.deleting = Promise.resolve()
      .then(async () => {
        await entry.server?.stop()
        this.controller.signal.throwIfAborted()
        await this.discovery.remove(
          entry.metadata.mainWorktreePath,
          entry.metadata.path,
          this.controller.signal,
          branchName,
        )
        if (branchName !== undefined) {
          try {
            await this.discovery.removeBranch(
              entry.metadata.mainWorktreePath,
              branchName,
              this.controller.signal,
            )
          } catch (error) {
            // The directory is gone. Keep the failure visible on its owning main worktree.
            const main = this.entries.get(
              vscodeBasePath(entry.metadata.mainWorktreePath),
            )
            this.recordError(
              main ?? entry,
              new Error(
                `Worktree ${entry.metadata.basename} was removed, but branch ${branchName} could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              ),
            )
          }
        }
        this.entries.delete(vscodeBasePath(entry.metadata.path))
      })
      .catch((error: unknown) => {
        this.recordError(entry, error)
      })
      .finally(() => {
        entry.deleting = undefined
        this.publish()
      })
    this.publish()
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.controller.abort(new Error('Worktree store closed'))
      this.onChangedListener = undefined
      this.closing = (async () => {
        const results = await Promise.allSettled([
          this.pending,
          ...this.cleanupTasks,
          ...[...this.entries.values()].map((entry) => entry.deleting),
          ...[...this.entries.values()].map((entry) => entry.server?.stop()),
        ])
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
        this.entries.clear()
      })()
    }
    return this.closing
  }
}
