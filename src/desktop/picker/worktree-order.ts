import type { Worktree } from '../../shared/api'
import type { RunningWorktree } from '../../shared/editor-rpc'

// Open recency belongs to this desktop session and survives server reconnects.
export class WorktreeOrder {
  private readonly lastOpened = new Map<string, number>()
  private sequence = 0

  recordOpen(path: string): void {
    this.lastOpened.set(path, ++this.sequence)
  }

  sort(worktrees: Worktree[]): Worktree[] {
    return [...worktrees].sort((a, b) => {
      const aStopped = a.vscode.state === 'stopped'
      const bStopped = b.vscode.state === 'stopped'
      return (
        Number(aStopped) - Number(bStopped) ||
        (!aStopped
          ? (this.lastOpened.get(b.path) ?? 0) -
            (this.lastOpened.get(a.path) ?? 0)
          : 0) ||
        a.basename.localeCompare(b.basename) ||
        a.path.localeCompare(b.path)
      )
    })
  }

  // The leading picker rows, without fields other views do not need.
  running(worktrees: Worktree[]): RunningWorktree[] {
    return this.sort(worktrees).flatMap(
      ({ path, basename, branchName, deleting, vscode: { state } }) =>
        state === 'stopped'
          ? []
          : [{ path, basename, branchName, state, deleting }],
    )
  }
}
