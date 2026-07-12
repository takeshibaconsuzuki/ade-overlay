import { execFile } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { type Logger } from '../../api/server/logger'
import { HttpError } from '../errors'
import { normalizePath } from '../paths'

const execFileAsync = promisify(execFile)

type RunGitOptions = {
  /**
   * When set, capture the command, its stdout and stderr to this file (appended)
   * on both success and failure. Used to surface creation logs for worktrees
   * that may never exist on disk.
   */
  logFilePath?: string
}

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
        current.path = normalizePath(value)
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

export async function listGitBranches(
  repositoryPath: string,
  log?: Logger,
): Promise<string[]> {
  const output = await runGit(
    repositoryPath,
    [
      'for-each-ref',
      '--format=%(refname:short)',
      '--sort=-committerdate',
      'refs/heads',
    ],
    log,
  )

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export async function runGit(
  cwd: string,
  args: string[],
  log?: Logger,
  options: RunGitOptions = {},
): Promise<string> {
  const directory = normalizePath(cwd)
  log?.debug({ cwd: directory, args }, 'running git command')
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
    })

    await captureGitLog(options.logFilePath, args, stdout, stderr, log)
    return stdout
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Git command failed'
    const { stdout, stderr } = asExecOutput(error)
    await captureGitLog(options.logFilePath, args, stdout, stderr, log, message)
    log?.warn({ cwd: directory, args, message }, 'git command failed')
    throw new HttpError(400, message)
  }
}

function asExecOutput(error: unknown): { stdout: string; stderr: string } {
  const record = error as { stdout?: unknown; stderr?: unknown }
  return {
    stdout: typeof record?.stdout === 'string' ? record.stdout : '',
    stderr: typeof record?.stderr === 'string' ? record.stderr : '',
  }
}

async function captureGitLog(
  logFilePath: string | undefined,
  args: string[],
  stdout: string,
  stderr: string,
  log?: Logger,
  errorMessage?: string,
): Promise<void> {
  if (!logFilePath) {
    return
  }

  const sections = [
    `$ git ${args.join(' ')}`,
    stdout.trim() && stdout,
    stderr.trim() && stderr,
    errorMessage && `error: ${errorMessage}`,
    '',
  ].filter((section): section is string => Boolean(section))

  try {
    await mkdir(dirname(logFilePath), { recursive: true })
    await appendFile(logFilePath, `${sections.join('\n')}\n`, 'utf8')
  } catch (error) {
    log?.warn({ err: error, logFilePath }, 'failed to write creation log')
  }
}
