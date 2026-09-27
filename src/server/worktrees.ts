import { exec, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import {
  createWorktreeInputSchema,
  deleteWorktreeInputSchema,
  type CreateWorktreeInput,
  type DeleteWorktreeInput,
  type Worktree,
  type WorktreeSnapshot,
  type WorktreeUpdate,
  type OpenEditorInput,
  type EditorSession,
  openEditorInputSchema,
  setWorktreeErrorInputSchema,
  type SetWorktreeErrorInput,
} from '../shared/companion.ts'
import { expandHome, type ServerConfig } from './config.ts'
import type { EditorManager } from './editors.ts'

const execute = promisify(execFile)
const executeShell = promisify(exec)

function worktreeKey(input: OpenEditorInput): string {
  return JSON.stringify([pathKey(input.project), pathKey(input.path)])
}

type RowState = {
  worktree: Worktree
  operation?: Worktree['operation']
  error?: string
}

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
        editor: 'stopped' as const,
      }
    })
}

export class WorktreeStore extends EventEmitter<{
  update: [WorktreeUpdate]
  operationFailed: [Worktree, unknown]
}> {
  private snapshot: WorktreeSnapshot = {
    revision: 0,
    projects: [],
    worktrees: [],
  }
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0
  private editors?: EditorManager
  private worktrees: Worktree[] = []
  private rows = new Map<string, RowState>()
  private projects = new Map<string, ServerConfig['projects'][number]>()

  static async open(
    projects: ServerConfig['projects'],
    editors?: EditorManager,
  ): Promise<WorktreeStore> {
    const store = new WorktreeStore()
    store.editors = editors
    editors?.on('status', () => store.publish(store.worktrees, 'editor'))
    const unique = new Map<string, string>()
    for (const project of projects) {
      const canonical = await realpath(project.mainWorktreePath)
      unique.set(pathKey(canonical), canonical)
      store.projects.set(canonical, { ...project, mainWorktreePath: canonical })
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
    store.snapshot.projects = paths
    await store.applyWorktrees(worktrees, 'refreshed', true)
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

  private publish(
    worktrees: Worktree[],
    change: WorktreeUpdate['change'],
    force = true,
  ): WorktreeSnapshot {
    const actual = new Set(worktrees.map(worktreeKey))
    const visible = [
      ...worktrees,
      ...[...this.rows.entries()]
        .filter(
          ([key, state]) =>
            !actual.has(key) && (state.operation || state.error),
        )
        .map(([, state]) => ({ ...state.worktree, missing: true })),
    ]
    const entries = visible.map((worktree) => ({
      ...worktree,
      operation: this.rows.get(worktreeKey(worktree))?.operation,
      error: this.rows.get(worktreeKey(worktree))?.error,
      editor: this.editors?.status(worktree) ?? 'stopped',
      editorDetail: this.editors?.detail(worktree),
    }))
    if (!force && isDeepStrictEqual(entries, this.snapshot.worktrees))
      return this.list()
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      worktrees: entries,
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

  // All Git membership changes pass here. Status-only broadcasts use publish
  // directly, so stopping a process cannot recursively trigger reconciliation.
  private async applyWorktrees(
    worktrees: Worktree[],
    change: WorktreeUpdate['change'],
    force = false,
  ): Promise<WorktreeSnapshot> {
    const retained = new Set(worktrees.map(worktreeKey))
    for (const previous of this.worktrees) {
      const key = worktreeKey(previous)
      if (!retained.has(key) && !this.rows.get(key)?.operation)
        this.rows.delete(key)
    }
    await this.editors?.retain(worktrees)
    this.worktrees = worktrees
    return this.publish(worktrees, change, force)
  }

  private async reconcileProject(
    project: string,
    change: WorktreeUpdate['change'],
  ): Promise<WorktreeSnapshot> {
    const entries = await scan(project)
    return this.applyWorktrees(
      this.snapshot.projects.flatMap((path) =>
        path === project
          ? entries
          : this.worktrees.filter((entry) => entry.project === path),
      ),
      change,
    )
  }

  refresh(): Promise<WorktreeSnapshot> {
    return this.serialize(async () => {
      const entries = (
        await Promise.all(this.snapshot.projects.map(scan))
      ).flat()
      return this.applyWorktrees(entries, 'refreshed', true)
    })
  }

  private find(input: OpenEditorInput): Worktree | undefined {
    return this.worktrees.find(
      (entry) => worktreeKey(entry) === worktreeKey(input),
    )
  }

  setError(input: SetWorktreeErrorInput): WorktreeSnapshot {
    input = setWorktreeErrorInputSchema.parse(input)
    const project = this.project(input.project)
    const target = { ...input, project }
    const key = worktreeKey(target)
    const state = this.rows.get(key)
    // An old page failure must not replace an in-flight mutation's status.
    if (state?.operation) return this.list()
    const worktree = this.find(target)
    if (input.error && worktree) {
      this.rows.set(key, { worktree, error: input.error })
    } else {
      this.rows.delete(key)
    }
    return this.publish(this.worktrees, 'operation')
  }

  async openEditor(input: OpenEditorInput): Promise<EditorSession> {
    input = openEditorInputSchema.parse(input)
    const key = worktreeKey(input)
    if (this.rows.get(key)?.operation)
      throw new Error('A worktree operation is still running.')
    const worktree = this.find(input)
    const state = worktree
      ? { worktree, error: this.rows.get(key)?.error }
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
        if (!this.editors)
          throw new Error('Editors are not available on this server.')
        await realpath(current.path)
        // Register startup in order, but release the queue during readiness.
        return { ready: this.editors.open(current) }
      }).then(({ ready }) => ready)
    } catch (error) {
      if (state && this.rows.get(key) === state && this.find(input)) {
        this.rows.set(key, {
          worktree: state.worktree,
          error: String(error instanceof Error ? error.message : error).slice(
            0,
            4096,
          ),
        })
        this.publish(this.worktrees, 'editor')
      }
      throw error
    } finally {
      if (state && !state.error && this.rows.get(key) === state)
        this.rows.delete(key)
    }
  }

  private schedule(
    worktree: Worktree,
    operation: NonNullable<Worktree['operation']>,
    run: () => Promise<unknown>,
  ): { accepted: WorktreeSnapshot; completed: Promise<WorktreeSnapshot> } {
    const key = worktreeKey(worktree)
    if (this.rows.get(key)?.operation)
      throw new Error('A worktree operation is already running.')
    if (this.pending >= 32)
      throw new Error('Too many pending worktree operations.')
    const state: RowState = { worktree, operation }
    this.rows.set(key, state)
    const accepted = this.publish(this.worktrees, 'operation')
    const completed = this.serialize(async () => {
      try {
        await run()
        this.rows.delete(key)
        return this.publish(
          this.worktrees,
          operation === 'creating' ? 'created' : 'deleted',
        )
      } catch (error) {
        state.operation = undefined
        state.error = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 4096)
        this.publish(this.worktrees, 'operation')
        this.emit('operationFailed', worktree, error)
        throw error
      }
    })
    // The row owns failures even after the requesting desktop disconnects.
    void completed.catch(() => {})
    return { accepted, completed }
  }

  private async prepareCreate(input: CreateWorktreeInput) {
    input = createWorktreeInputSchema.parse(input)
    const project = this.project(input.project)
    const path = await creationPath(resolve(project, expandHome(input.path)))
    const branch = input.branch.trim()
    if (this.find({ project, path }))
      throw new Error('Worktree already exists at this path.')
    const worktree: Worktree = {
      project,
      path,
      branch: branch || input.baseBranch,
      head: '',
      main: false,
      locked: false,
      prunable: false,
      editor: 'stopped',
    }
    return this.schedule(worktree, 'creating', async () => {
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
        const command = this.projects.get(project)?.bootstrapCommand
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
      await this.reconcileProject(project, 'refreshed')
    })
  }

  async startCreate(input: CreateWorktreeInput): Promise<WorktreeSnapshot> {
    return (await this.prepareCreate(input)).accepted
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeSnapshot> {
    return (await this.prepareCreate(input)).completed
  }

  private prepareDelete(input: DeleteWorktreeInput) {
    input = deleteWorktreeInputSchema.parse(input)
    const project = this.project(input.project)
    const worktree = this.find({ ...input, project })
    if (!worktree)
      throw new Error('Worktree is not in the cache. Refresh the list first.')
    if (worktree.main) throw new Error('The main worktree cannot be deleted.')
    if (worktree.locked)
      throw new Error('Unlock this worktree in Git before deleting it.')
    return this.schedule(worktree, 'deleting', async () => {
      // Never force removal or delete branches. A failed removal leaves the
      // editor stopped; it can be reopened after the user handles the error.
      await this.editors?.stop(worktree)
      await git(project, ['worktree', 'remove', '--', worktree.path])
      await this.applyWorktrees(
        this.worktrees.filter(
          (entry) => worktreeKey(entry) !== worktreeKey(worktree),
        ),
        'refreshed',
      )
    })
  }

  async startDelete(input: DeleteWorktreeInput): Promise<WorktreeSnapshot> {
    return this.prepareDelete(input).accepted
  }

  async delete(input: DeleteWorktreeInput): Promise<WorktreeSnapshot> {
    return this.prepareDelete(input).completed
  }
}
