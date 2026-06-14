import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export async function canonicalizePath(path: string): Promise<string> {
  return realpath(normalizePath(path))
}

/**
 * Canonicalize a path that may not exist yet. Used to mint a stable worktree id
 * before `git worktree add` creates the directory: git reports realpath'd
 * worktree paths, so deriving the id from the canonical path up front keeps the
 * optimistic row's id identical to the eventual git-derived id.
 *
 * Resolves the path itself when it exists, otherwise the (existing) parent
 * directory plus the requested name. Throws if the parent does not exist.
 */
export async function precanonicalizePath(path: string): Promise<string> {
  const normalized = normalizePath(path)
  try {
    return await realpath(normalized)
  } catch (error) {
    // Only a missing path warrants the parent fallback; surface anything else
    // (e.g. EACCES) rather than silently mis-canonicalizing.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const canonicalParent = await realpath(dirname(normalized))
  return join(canonicalParent, basename(normalized))
}

export function normalizePath(path: string): string {
  if (path === '~') {
    return homedir()
  }

  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2))
  }

  return resolve(path)
}
