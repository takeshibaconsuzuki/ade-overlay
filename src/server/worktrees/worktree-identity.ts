import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { OpenEditorInput } from '../../shared/companion.ts'

// Physical paths are resolved at discovery/admission, including the existing
// ancestor of a creation destination. Keys must also work after paths disappear.
export function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function identity(worktree: OpenEditorInput): [string, string] {
  return [pathKey(worktree.project), pathKey(worktree.path)]
}

export function worktreeKey(worktree: OpenEditorInput): string {
  return JSON.stringify(identity(worktree))
}

export function editorId(worktree: OpenEditorInput): string {
  // This encoding names persistent workspace data. Preserve the NUL separator
  // and SHA-256 digest when changing other identity consumers.
  return createHash('sha256')
    .update(identity(worktree).join('\0'))
    .digest('hex')
}
