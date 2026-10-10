import { basename, resolve } from 'node:path'
import { simpleGit } from 'simple-git'
import type { Worktree } from '../shared/api'
import { logger } from '../shared/logger'
import type { Project } from './options'

const log = logger.child({ component: 'worktrees' })

export function parseWorktrees(output: string): Worktree[] {
  return output
    .split('\0\0')
    .filter(Boolean)
    .flatMap((record) => {
      const fields = record.split('\0')
      const path = fields
        .find((field) => field.startsWith('worktree '))
        ?.slice(9)
      if (!path || fields.includes('bare')) return []
      const branch = fields
        .find((field) => field.startsWith('branch '))
        ?.slice(7)
      return [
        {
          path,
          basename: basename(path),
          branchName: branch?.replace(/^refs\/heads\//, '') ?? null,
        },
      ]
    })
}

export async function listWorktrees(
  projects: Project[],
  signal?: AbortSignal,
): Promise<Worktree[]> {
  signal?.throwIfAborted()
  const results = await Promise.all(
    projects.map(async ({ mainWorktreePath }) => {
      try {
        const output = await simpleGit({
          baseDir: resolve(mainWorktreePath),
          abort: signal,
          timeout: { block: 10_000 },
        }).raw(['worktree', 'list', '--porcelain', '-z'])
        return parseWorktrees(output)
      } catch (error) {
        // Let every project settle before reporting cancellation to the store.
        if (signal?.aborted) return []
        log.error(
          { err: error, mainWorktreePath },
          'Failed to list project worktrees',
        )
        return []
      }
    }),
  )
  signal?.throwIfAborted()
  return [
    ...new Map(
      results.flat().map((worktree) => [worktree.path, worktree]),
    ).values(),
  ]
}
