import { exec, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import type {
  CreateWorktreeInput,
  DeleteWorktreeInput,
  Worktree,
  WorktreeSnapshot,
  OpenEditorInput,
  EditorSession,
  SetWorktreeErrorInput,
} from '../../shared/companion.ts'
import { expandHome, type ServerConfig } from '../config.ts'
import type { EditorLifecycle } from '../editors/editor-manager.ts'
import { pathKey, worktreeKey } from './worktree-identity.ts'
import { WorktreeColors } from './worktree-colors.ts'

const execute = promisify(execFile)
const executeShell = promisify(exec)

interface GitWorktree {
  project: string
  path: string
  branch: string | null
  main: boolean
  locked: boolean
  prunable: boolean
}

type WorktreeTarget = Pick<GitWorktree, 'project' | 'path' | 'branch'>

type RowState = {
  target: WorktreeTarget
  operation?: Worktree['operation']
  error?: string
  deletionFailure?: Worktree['deletionFailure']
}

class WorktreeRemovalError extends Error {
  readonly details: NonNullable<Worktree['deletionFailure']>

  constructor(
    cause: unknown,
    details: NonNullable<Worktree['deletionFailure']>,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.details = details
  }
}

async function removalFiles(path: string): Promise<string[]> {
  const status = await git(path, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignored=matching',
    '--ignore-submodules=none',
  ])
  const records = status.split('\0').filter(Boolean)
  const files = new Set<string>()
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    files.add(record.slice(3))
    if (/[RC]/.test(record.slice(0, 2))) files.add(records[++index])
  }
  // Even clean submodules prevent removal without --force.
  const tracked = await git(path, ['ls-files', '--stage', '-z'])
  for (const record of tracked.split('\0')) {
    if (record.startsWith('160000 '))
      files.add(record.slice(record.indexOf('\t') + 1))
  }
  return [...files].sort()
}

async function git(project: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute('git', ['-C', project, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    })
    return stdout
  } catch (error) {
    const failure = error as Error & { stderr?: string }
    throw new Error(failure.stderr?.trim() || failure.message, { cause: error })
  }
}

async function creationPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    const parent = dirname(path)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path)
      throw error
    // Git can create missing parent directories. Resolve their nearest existing
    // ancestor so pending state uses the same physical path Git will report.
    return resolve(await creationPath(parent), basename(path))
  }
}

async function scan(project: string): Promise<GitWorktree[]> {
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
        branch: fields.get('branch')?.replace(/^refs\/heads\//, '') ?? null,
        main: index === 0,
        locked: fields.has('locked'),
        prunable: fields.has('prunable'),
      }
    })
}

export class WorktreeStore extends EventEmitter<{
  update: [WorktreeSnapshot]
  operationFailed: [WorktreeTarget, unknown]
}> {
  private snapshot: WorktreeSnapshot = {
    revision: 0,
    projects: [],
    worktrees: [],
  }
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0
  private closing = false
  private readonly admissions = new Set<Promise<unknown>>()
  private readonly editors: EditorLifecycle
  private worktrees: GitWorktree[] = []
  private rows = new Map<string, RowState>()
  private projects = new Map<string, ServerConfig['projects'][number]>()

  private readonly colors: WorktreeColors

  private constructor(editors: EditorLifecycle, colors: WorktreeColors) {
    super()
    this.editors = editors
    this.colors = colors
  }

  static async open(
    projects: ServerConfig['projects'],
    editors: EditorLifecycle,
    colors = new WorktreeColors(),
  ): Promise<WorktreeStore> {
    const store = new WorktreeStore(editors, colors)
    editors.on('status', () => store.publish())
    for (const project of projects) {
      const canonical = await realpath(project.mainWorktreePath)
      store.projects.set(pathKey(canonical), {
        ...project,
        mainWorktreePath: canonical,
      })
    }
    const paths = [...store.projects.values()].map(
      (project) => project.mainWorktreePath,
    )
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
    store.snapshot.projects = paths
    await store.applyWorktrees(worktrees, true)
    return store
  }

  // A synchronous, detached snapshot; listing never invokes Git.
  list(): WorktreeSnapshot {
    return structuredClone(this.snapshot)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
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

  private accepting(): void {
    if (this.closing) throw new Error('Companion is shutting down.')
  }

  private async admit<T>(operation: () => Promise<T>): Promise<T> {
    this.accepting()
    if (this.pending + this.admissions.size >= 32)
      throw new Error('Too many pending worktree operations.')
    const admission = operation()
    this.admissions.add(admission)
    try {
      return await admission
    } finally {
      this.admissions.delete(admission)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled(this.admissions)
    await this.queue
  }

  private publish(force = true): WorktreeSnapshot {
    const actual = new Map(
      this.worktrees.map((worktree) => [worktreeKey(worktree), worktree]),
    )
    const visible = new Map<string, GitWorktree | WorktreeTarget>(actual)
    for (const [key, state] of this.rows) {
      if (!actual.has(key) && (state.operation || state.error))
        visible.set(key, state.target)
    }
    const entries: Worktree[] = [...visible].map(([key, target]) => ({
      main: false,
      locked: false,
      prunable: false,
      ...target,
      ...(!actual.has(key) && { missing: true }),
      operation: this.rows.get(key)?.operation,
      error: this.rows.get(key)?.error,
      ...(this.rows.get(key)?.deletionFailure && {
        deletionFailure: this.rows.get(key)!.deletionFailure,
      }),
      color:
        this.editors.status(target) === 'stopped'
          ? undefined
          : this.colors.get(target),
      editor: this.editors.status(target),
      editorDetail: this.editors.detail(target),
    }))
    if (!force && isDeepStrictEqual(entries, this.snapshot.worktrees))
      return this.list()
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      worktrees: entries,
    }
    this.emit('update', this.list())
    return this.list()
  }

  private project(path: string): string {
    const project = this.projects.get(pathKey(path))
    if (!project) throw new Error('Project is not configured on this server.')
    return project.mainWorktreePath
  }

  // All Git membership changes pass here. Status-only broadcasts use publish
  // directly, so stopping a process cannot recursively trigger reconciliation.
  private async applyWorktrees(
    worktrees: GitWorktree[],
    force = false,
  ): Promise<WorktreeSnapshot> {
    const retained = new Set(worktrees.map(worktreeKey))
    for (const previous of this.worktrees) {
      const key = worktreeKey(previous)
      if (!retained.has(key) && !this.rows.get(key)?.operation)
        this.rows.delete(key)
    }
    await this.editors.retain(worktrees)
    this.worktrees = worktrees
    return this.publish(force)
  }

  private async reconcileProject(project: string): Promise<WorktreeSnapshot> {
    const entries = await scan(project)
    return this.applyWorktrees(
      this.snapshot.projects.flatMap((path) =>
        path === project
          ? entries
          : this.worktrees.filter((entry) => entry.project === path),
      ),
    )
  }

  refresh(): Promise<WorktreeSnapshot> {
    this.accepting()
    return this.serialize(async () => {
      const entries = (
        await Promise.all(this.snapshot.projects.map(scan))
      ).flat()
      return this.applyWorktrees(entries, true)
    })
  }

  private find(input: OpenEditorInput): GitWorktree | undefined {
    return this.worktrees.find(
      (entry) => worktreeKey(entry) === worktreeKey(input),
    )
  }

  setError(input: SetWorktreeErrorInput): WorktreeSnapshot {
    this.accepting()
    const project = this.project(input.project)
    const target = { ...input, project }
    const key = worktreeKey(target)
    const state = this.rows.get(key)
    // An old page failure must not replace an in-flight mutation's status.
    if (state?.operation) return this.list()
    const worktree = this.find(target)
    if (input.error && worktree) {
      this.rows.set(key, { target: worktree, error: input.error })
    } else {
      this.rows.delete(key)
    }
    return this.publish()
  }

  async openEditor(input: OpenEditorInput): Promise<EditorSession> {
    this.accepting()
    const key = worktreeKey(input)
    if (this.rows.get(key)?.operation)
      throw new Error('A worktree operation is still running.')
    const worktree = this.find(input)
    const state = worktree
      ? { target: worktree, error: this.rows.get(key)?.error }
      : undefined
    if (state) {
      this.rows.set(key, state)
    }
    try {
      return await this.serialize(async () => {
        this.project(input.project)
        const current = this.find(input)
        if (!current || current.prunable)
          throw new Error('Worktree is unavailable. Refresh the list first.')
        await realpath(current.path)
        await this.colors.assign(current)
        // Register startup in order, but release the queue during readiness.
        return {
          ready: this.editors.open(
            current,
            this.projects.get(pathKey(current.project))?.chatCommands,
          ),
        }
      }).then(({ ready }) => ready)
    } catch (error) {
      if (state && this.rows.get(key) === state && this.find(input)) {
        this.rows.set(key, {
          target: state.target,
          error: String(error instanceof Error ? error.message : error).slice(
            0,
            4096,
          ),
        })
        this.publish()
      }
      throw error
    } finally {
      if (state && !state.error && this.rows.get(key) === state)
        this.rows.delete(key)
    }
  }

  private schedule(
    target: WorktreeTarget,
    operation: NonNullable<Worktree['operation']>,
    run: () => Promise<unknown>,
  ): WorktreeSnapshot {
    const key = worktreeKey(target)
    if (this.rows.get(key)?.operation)
      throw new Error('A worktree operation is already running.')
    if (this.pending >= 32)
      throw new Error('Too many pending worktree operations.')
    const state: RowState = { target, operation }
    this.rows.set(key, state)
    const accepted = this.publish()
    // The row owns failures even after the requesting desktop disconnects.
    void this.serialize(async () => {
      try {
        await run()
        this.rows.delete(key)
        this.publish()
      } catch (error) {
        state.operation = undefined
        if (error instanceof WorktreeRemovalError)
          state.deletionFailure = error.details
        state.error = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 4096)
        this.publish()
        this.emit('operationFailed', target, error)
      }
    }).catch(() => {})
    return accepted
  }

  startCreate(input: CreateWorktreeInput): Promise<WorktreeSnapshot> {
    return this.admit(() => this.create(input))
  }

  private async create(input: CreateWorktreeInput): Promise<WorktreeSnapshot> {
    const project = this.project(input.project)
    const path = await creationPath(resolve(project, expandHome(input.path)))
    const branch = input.branch.trim()
    if (this.find({ project, path }))
      throw new Error('Worktree already exists at this path.')
    const target: WorktreeTarget = {
      project,
      path,
      branch: branch || input.baseBranch,
    }
    return this.schedule(target, 'creating', async () => {
      try {
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
        await git(project, args)
        const command = this.projects.get(pathKey(project))?.bootstrapCommand
        if (command?.trim()) {
          try {
            await executeShell(command, {
              cwd: path,
              shell: os.userInfo().shell || undefined,
              windowsHide: true,
              maxBuffer: 16 * 1024 * 1024,
            })
          } catch (error) {
            const failure = error as Error & { stderr?: string }
            throw new Error(
              `Bootstrap command failed: ${failure.stderr?.trim() || failure.message}`,
              { cause: error },
            )
          }
        }
      } catch (error) {
        // Checkout hooks and bootstrap commands can fail after Git created it.
        try {
          await this.reconcileProject(project)
        } catch (reconciliationError) {
          throw new AggregateError(
            [error, reconciliationError],
            `${(error as Error).message}\nCould not refresh worktrees: ${(reconciliationError as Error).message}`,
            { cause: reconciliationError },
          )
        }
        throw error
      }
      await this.reconcileProject(project)
    })
  }

  async startDelete(input: DeleteWorktreeInput): Promise<WorktreeSnapshot> {
    this.accepting()
    const project = this.project(input.project)
    const worktree = this.find({ ...input, project })
    if (!worktree)
      throw new Error('Worktree is not in the cache. Refresh the list first.')
    if (worktree.main) throw new Error('The main worktree cannot be deleted.')
    if (worktree.locked)
      throw new Error('Unlock this worktree in Git before deleting it.')
    return this.schedule(worktree, 'deleting', async () => {
      // Recheck external Git changes before choosing which branch to delete.
      let current: GitWorktree | undefined
      try {
        current = (await scan(project)).find(
          (entry) => worktreeKey(entry) === worktreeKey(worktree),
        )
        if (!current)
          throw new Error('Worktree no longer exists. Refresh the list first.')
        if (current.main)
          throw new Error('The main worktree cannot be deleted.')
        if (current.locked)
          throw new Error(
            'This worktree is locked. Unlock it in Git before deleting it.',
          )
        if (input.deleteBranch && !current.branch)
          throw new Error('This worktree has no branch to delete.')
        if (input.deleteBranch && current.branch !== worktree.branch)
          throw new Error(
            'The worktree branch changed. Refresh the list before deleting its branch.',
          )
        await this.editors.stop(current)
        await git(project, [
          'worktree',
          'remove',
          ...(input.force ? ['--force'] : []),
          '--',
          current.path,
        ])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        let files: string[] = []
        let canForce =
          !input.force &&
          /contains modified or untracked files|working trees containing submodules/.test(
            message,
          )
        try {
          files = await removalFiles(worktree.path)
        } catch {
          // Do not offer a destructive retry when its contents cannot be shown.
          canForce = false
        }
        throw new WorktreeRemovalError(error, {
          files,
          canForce,
          deleteBranch: !!input.deleteBranch,
        })
      }
      await this.applyWorktrees(
        this.worktrees.filter(
          (entry) => worktreeKey(entry) !== worktreeKey(worktree),
        ),
      )
      if (input.deleteBranch && current?.branch) {
        try {
          await git(project, ['branch', '-D', '--', current.branch])
        } catch (error) {
          throw new Error(
            `Worktree removed, but branch "${current.branch}" could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
      }
    })
  }
}
