import type { NotificationConstructorOptions } from 'electron'
import type {
  OpenEditorInput,
  Worktree,
  WorktreeSnapshot,
} from '../shared/companion.ts'

interface WorktreeNotification {
  on(event: 'click', listener: () => void): unknown
  on(
    event: 'failed',
    listener: (event: unknown, error: string) => void,
  ): unknown
  removeAllListeners(): unknown
  show(): void
  close(): void
}

// Paths in accepted snapshots are already canonicalized by the companion,
// whose platform may differ from the desktop's.
const key = (worktree: OpenEditorInput): string =>
  JSON.stringify([worktree.project, worktree.path])

export class WorktreeNotifications {
  private worktrees = new Map<string, Worktree>()
  private readonly notifications = new Map<string, WorktreeNotification>()
  private readonly create: (
    options: NotificationConstructorOptions,
  ) => WorktreeNotification | undefined
  private readonly open: (input: OpenEditorInput) => Promise<unknown>
  private readonly onError: (error: unknown) => void

  constructor(
    create: WorktreeNotifications['create'],
    open: WorktreeNotifications['open'],
    onError: WorktreeNotifications['onError'],
  ) {
    this.create = create
    this.open = open
    this.onError = onError
  }

  // Only feed snapshots accepted by CompanionState: command replies and
  // broadcasts can duplicate or arrive out of order.
  update(snapshot: WorktreeSnapshot): void {
    const previous = this.worktrees
    this.worktrees = new Map(snapshot.worktrees.map((row) => [key(row), row]))
    for (const [id, row] of this.worktrees) {
      if (
        previous.get(id)?.operation === 'creating' &&
        row.operation === undefined
      )
        this.show(id, row)
    }
  }

  private show(id: string, worktree: Worktree): void {
    this.dismiss(id)
    const notification = this.create({
      title: worktree.error
        ? 'Worktree creation failed'
        : 'Worktree creation completed',
      body: worktree.error
        ? `${worktree.path}\n${worktree.error}`
        : worktree.path,
    })
    if (!notification) return
    this.notifications.set(id, notification)
    notification.on('click', () => {
      this.dismiss(id)
      const current = this.worktrees.get(id)
      if (!current || current.missing || current.prunable || current.operation)
        return
      void this.open({ project: current.project, path: current.path }).catch(
        this.onError,
      )
    })
    notification.on('failed', (_event, error) => {
      this.dismiss(id)
      console.warn('[ADE] Could not show worktree notification:', error)
    })
    // Keep clicks working when Windows moves the toast to Action Center.
    notification.show()
  }

  clear(): void {
    this.worktrees.clear()
    for (const id of this.notifications.keys()) this.dismiss(id)
  }

  private dismiss(id: string): void {
    const notification = this.notifications.get(id)
    if (!notification) return
    this.notifications.delete(id)
    notification.removeAllListeners()
    notification.close()
  }
}
