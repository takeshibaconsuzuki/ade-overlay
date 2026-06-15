import type { Worktree } from './worktrees'

/** The worktree directory name, used as the primary label. */
export function worktreeName(worktree: Worktree): string {
  return worktree.path.split('/').pop() || worktree.path
}

/** The branch the worktree is on, used as the secondary label. */
export function worktreeBranch(worktree: Worktree): string {
  if (worktree.branchName) {
    return worktree.branchName
  }
  if (worktree.isDetached && worktree.head) {
    return `detached @ ${worktree.head.slice(0, 7)}`
  }
  return '—'
}

export function worktreeLabel(worktree: Worktree): string {
  return `${worktreeName(worktree)} ${worktreeBranch(worktree)}`
}
