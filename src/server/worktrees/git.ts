import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type Logger } from '../../api/server/logger'
import { HttpError } from '../errors'
import { normalizePath } from '../paths'

const execFileAsync = promisify(execFile)

export type GitWorktree = {
  path: string
  head?: string
  branch?: string
  isBare: boolean
  isDetached: boolean
  isPrunable: boolean
  prunableReason?: string
}

export async function listGitWorktrees(
  repositoryPath: string,
  log?: Logger,
): Promise<GitWorktree[]> {
  const output = await runGit(
    repositoryPath,
    ['worktree', 'list', '--porcelain', '-z'],
    log,
  )
  const records: GitWorktree[] = []
  let current: Partial<GitWorktree> = {}

  for (const field of output.split('\0')) {
    if (!field) {
      if (current.path) {
        records.push({
          path: current.path,
          head: current.head,
          branch: current.branch,
          isBare: current.isBare ?? false,
          isDetached: current.isDetached ?? false,
          isPrunable: current.isPrunable ?? false,
          prunableReason: current.prunableReason,
        })
      }

      current = {}
      continue
    }

    const [key, ...valueParts] = field.split(' ')
    const value = valueParts.join(' ')

    switch (key) {
      case 'worktree':
        current.path = value
        break
      case 'HEAD':
        current.head = value
        break
      case 'branch':
        current.branch = value
        break
      case 'bare':
        current.isBare = true
        break
      case 'detached':
        current.isDetached = true
        break
      case 'prunable':
        current.isPrunable = true
        current.prunableReason = value || undefined
        break
    }
  }

  return records
}

export async function runGit(
  cwd: string,
  args: string[],
  log?: Logger,
): Promise<string> {
  const directory = normalizePath(cwd)
  log?.debug({ cwd: directory, args }, 'running git command')
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
    })

    return stdout
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Git command failed'
    log?.warn({ cwd: directory, args, message }, 'git command failed')
    throw new HttpError(400, message)
  }
}
