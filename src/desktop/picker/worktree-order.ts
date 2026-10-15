import type { Worktree } from '../../shared/api'

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
}
