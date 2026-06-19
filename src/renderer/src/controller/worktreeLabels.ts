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

/**
 * A 32-bit string hash with strong avalanche mixing (FNV-1a followed by an
 * integer finalizer). Unlike a plain polynomial hash, a single-character change
 * scrambles the whole result, so similar names like `dummy1` and `dummy3` map
 * to unrelated values rather than neighbors.
 */
function avalancheHash(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * A deterministic CSS color for a worktree, derived from its display name so the
 * same worktree always shows the same color across every view. The hashed name
 * drives a hue across the full wheel (no fixed palette to bucket into); fixed
 * saturation and lightness keep every result legible on the dark theme.
 *
 * Apply via the `style` prop, e.g. `style={{ color: worktreeColor(name) }}` —
 * Radix's `color` prop only accepts named accents, not arbitrary colors.
 */
export function worktreeColor(name: string): string {
  const hue = avalancheHash(name) % 360
  return `hsl(${hue}, 65%, 67%)`
}
