import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import {
  createWorktreeInputSchema,
  deleteWorktreeInputSchema,
  type CreateWorktreeInput,
  type DeleteWorktreeInput,
  type Worktree,
  type WorktreeSnapshot,
  type WorktreeUpdate,
} from '../shared/companion.ts'
import { expandHome } from './config.ts'

const execute = promisify(execFile)

async function git(project: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute('git', ['-C', project, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  } catch (error) {
    const failure = error as Error & { stderr?: string }
    throw new Error(failure.stderr?.trim() || failure.message, { cause: error })
  }
}

function pathKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function scan(project: string): Promise<Worktree[]> {
  const output = await git(project, ['worktree', 'list', '--porcelain', '-z'])
  return output
    .split('\0\0')
    .filter(Boolean)
    .map((record, index) => {
      const fields = new Map(
        record
          .split('\0')
          .filter(Boolean)
          .map((field) => {
            const space = field.indexOf(' ')
            return space < 0
              ? [field, '']
              : [field.slice(0, space), field.slice(space + 1)]
          }),
      )
      const path = fields.get('worktree')
      if (!path || fields.has('bare'))
        throw new Error(`Expected a non-bare main worktree at ${project}.`)
      return {
        project,
        path: resolve(path),
        head: fields.get('HEAD') ?? '',
        branch: fields.get('branch')?.replace(/^refs\/heads\//, '') ?? null,
        main: index === 0,
        locked: fields.has('locked'),
        prunable: fields.has('prunable'),
      }
    })
}

export class WorktreeStore extends EventEmitter<{ update: [WorktreeUpdate] }> {
  private snapshot: WorktreeSnapshot = {
    revision: 0,
    projects: [],
    worktrees: [],
  }
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0

  static async open(projects: string[]): Promise<WorktreeStore> {
    const store = new WorktreeStore()
    const unique = new Map<string, string>()
    for (const project of projects) {
      const canonical = await realpath(project)
      unique.set(pathKey(canonical), canonical)
    }
    const paths = [...unique.values()]
    const worktrees = (
      await Promise.all(
        paths.map(async (project) => {
          const entries = await scan(project)
          if (
            !entries[0] ||
            pathKey(await realpath(entries[0].path)) !== pathKey(project)
          ) {
            throw new Error(`Project must be a main worktree root: ${project}`)
          }
          return entries
        }),
      )
    ).flat()
    store.snapshot = { revision: 1, projects: paths, worktrees }
    return store
  }

  // A synchronous, detached snapshot; listing never invokes Git.
  list(): WorktreeSnapshot {
    return structuredClone(this.snapshot)
  }

  private serialize(
    operation: () => Promise<WorktreeSnapshot>,
  ): Promise<WorktreeSnapshot> {
    if (this.pending >= 32)
      return Promise.reject(new Error('Too many pending worktree operations.'))
    this.pending++
    const result = this.queue.then(operation).finally(() => {
      this.pending--
    })
    this.queue = result.catch(() => {})
    return result
  }

  settled(): Promise<unknown> {
    return this.queue
  }

  private publish(
    worktrees: Worktree[],
    change: WorktreeUpdate['change'],
  ): WorktreeSnapshot {
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      worktrees,
    }
    this.emit('update', { change, snapshot: this.list() })
    return this.list()
  }

  private project(path: string): string {
    const project = this.snapshot.projects.find(
      (entry) => pathKey(entry) === pathKey(path),
    )
    if (!project) throw new Error('Project is not configured on this server.')
    return project
  }

  private async reconcileProject(
    project: string,
    change: WorktreeUpdate['change'],
  ): Promise<WorktreeSnapshot> {
    const entries = await scan(project)
    const current = this.snapshot.worktrees.filter(
      (entry) => entry.project === project,
    )
    if (isDeepStrictEqual(entries, current)) return this.list()
    return this.publish(
      [
        ...this.snapshot.worktrees.filter((entry) => entry.project !== project),
        ...entries,
      ],
      change,
    )
  }

  refresh(): Promise<WorktreeSnapshot> {
    return this.serialize(async () =>
      this.publish(
        (await Promise.all(this.snapshot.projects.map(scan))).flat(),
        'refreshed',
      ),
    )
  }

  create(input: CreateWorktreeInput): Promise<WorktreeSnapshot> {
    return this.serialize(async () => {
      input = createWorktreeInputSchema.parse(input)
      const project = this.project(input.project)
      const path = resolve(project, expandHome(input.path))
      const branch = input.branch.trim()
      // Preserve the branch name: passing its commit hash would detach HEAD.
      let args = ['worktree', 'add', '--', path, input.baseBranch]
      if (branch) {
        if (branch.startsWith('-'))
          throw new Error('Branch names cannot start with a dash.')
        await git(project, ['check-ref-format', `refs/heads/${branch}`])
        const commit = (
          await git(project, [
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${input.baseBranch}^{commit}`,
          ])
        ).trim()
        args = ['worktree', 'add', '-b', branch, '--', path, commit]
      }
      try {
        await git(project, args)
      } catch (error) {
        // A failing checkout hook can leave a worktree behind.
        try {
          await this.reconcileProject(project, 'refreshed')
        } catch (reconciliationError) {
          throw new AggregateError(
            [error, reconciliationError],
            `${(error as Error).message}\nCould not refresh worktrees: ${(reconciliationError as Error).message}`,
            { cause: reconciliationError },
          )
        }
        throw error
      }
      return this.reconcileProject(project, 'created')
    })
  }

  delete(input: DeleteWorktreeInput): Promise<WorktreeSnapshot> {
    return this.serialize(async () => {
      input = deleteWorktreeInputSchema.parse(input)
      const project = this.project(input.project)
      const worktree = this.snapshot.worktrees.find(
        (entry) =>
          entry.project === project &&
          pathKey(entry.path) === pathKey(input.path),
      )
      if (!worktree)
        throw new Error('Worktree is not in the cache. Refresh the list first.')
      if (worktree.main) throw new Error('The main worktree cannot be deleted.')
      if (worktree.locked)
        throw new Error('Unlock this worktree in Git before deleting it.')
      // Git refuses dirty or locked trees; never force removal or delete branches.
      await git(project, ['worktree', 'remove', '--', worktree.path])
      return this.publish(
        this.snapshot.worktrees.filter((entry) => entry !== worktree),
        'deleted',
      )
    })
  }
}
