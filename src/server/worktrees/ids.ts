import { createHash } from 'node:crypto'
import { normalizePath } from '../paths'

const WORKTREE_ID_LENGTH = 12

export function createWorktreeId(worktreePath: string): string {
  return createHash('sha256')
    .update(normalizePath(worktreePath))
    .digest('hex')
    .slice(0, WORKTREE_ID_LENGTH)
}
