import { realpath } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { simpleGit } from 'simple-git'
import type { WorktreeInfo } from '../shared/api'
import type { Project } from './options'
import { pathKey } from './path-key'

export function parseWorktrees(output: string): WorktreeInfo[] {
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

export interface DiscoveredWorktree extends WorktreeInfo {
  // Configured path, retained separately from Git's canonical main root for project removal.
  projectPath: string
  mainWorktreePath: string
}

export interface WorktreeDiscovery {
  scan(projects: Project[], signal: AbortSignal): Promise<DiscoveredWorktree[]>
  remove(
    mainWorktreePath: string,
    path: string,
    signal: AbortSignal,
    branchName?: string,
  ): Promise<void>
  removeBranch(
    mainWorktreePath: string,
    branchName: string,
    signal: AbortSignal,
  ): Promise<void>
}

export class GitWorktreeDiscovery implements WorktreeDiscovery {
  scan(
    projects: Project[],
    signal: AbortSignal,
  ): Promise<DiscoveredWorktree[]> {
    return listWorktrees(projects, signal)
  }

  async remove(
    mainWorktreePath: string,
    path: string,
    signal: AbortSignal,
    branchName?: string,
  ): Promise<void> {
    signal.throwIfAborted()
    const git = simpleGit({ baseDir: mainWorktreePath, abort: signal })
    if (branchName !== undefined) {
      const worktrees = parseWorktrees(
        await git.raw(['worktree', 'list', '--porcelain', '-z']),
      )
      const worktree = worktrees.find(
        (worktree) => pathKey(worktree.path) === pathKey(path),
      )
      if (!branchName || worktree?.branchName !== branchName)
        throw new Error('Worktree branch changed; refresh and try again')
    }
    signal.throwIfAborted()
    await git.raw(['worktree', 'remove', '--', path])
  }

  async removeBranch(
    mainWorktreePath: string,
    branchName: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    await simpleGit({ baseDir: mainWorktreePath, abort: signal }).raw([
      'branch',
      '-d',
      '--',
      branchName,
    ])
  }
}

// Resolves the root of the worktree containing a path, or the path itself outside Git.
export async function findWorktreeRoot(path: string): Promise<string> {
  try {
    return resolve((await simpleGit(path).revparse(['--show-toplevel'])).trim())
  } catch {
    return resolve(path)
  }
}

export async function listWorktrees(
  projects: Project[],
  signal?: AbortSignal,
): Promise<DiscoveredWorktree[]> {
  signal?.throwIfAborted()
  // Settle every command before rejecting, so shutdown also waits for Git cleanup.
  const results = await Promise.allSettled(
    projects.map(async ({ mainWorktreePath }) => {
      const configured = resolve(mainWorktreePath)
      const output = await simpleGit({
        baseDir: configured,
        abort: signal,
        timeout: { block: 10_000 },
      }).raw(['worktree', 'list', '--porcelain', '-z'])
      signal?.throwIfAborted()
      const first = output.split('\0\0')[0].split('\0')
      const main = first
        .find((field) => field.startsWith('worktree '))
        ?.slice(9)
      if (
        !main ||
        first.includes('bare') ||
        pathKey(await realpath(configured)) !== pathKey(main)
      ) {
        throw new Error(
          `Configured mainWorktreePath is not the main worktree root: ${mainWorktreePath}`,
        )
      }
      return {
        identity: pathKey(main),
        worktrees: parseWorktrees(output).map((worktree) => ({
          ...worktree,
          path: resolve(worktree.path),
          mainWorktreePath: resolve(main),
          projectPath: configured,
        })),
      }
    }),
  )
  signal?.throwIfAborted()
  const identities = new Set<string>()
  const worktrees: DiscoveredWorktree[] = []
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason
    if (identities.has(result.value.identity))
      throw new Error(
        `Duplicate project for main worktree: ${result.value.identity}`,
      )
    identities.add(result.value.identity)
    worktrees.push(...result.value.worktrees)
  }
  return worktrees
}
