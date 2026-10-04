import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, lstat, open, readdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import type {
  WorktreeBranch,
  CreateWorktreeInput,
  WorktreePathTemplates,
  DeleteWorktreeInput,
  Worktree,
  WorktreeSnapshot,
  WorktreeRef,
  EditorServerSession,
  SetWorktreeErrorInput,
} from '../../shared/companion.ts'
import { expandHome, type ServerConfig } from '../config.ts'
import type { EditorServerLifecycle } from '../editors/editor-manager.ts'
import { editorServerId, pathKey, worktreeKey } from './worktree-identity.ts'
import { WorktreeColors } from './worktree-colors.ts'

const execute = promisify(execFile)

interface GitWorktree {
  project: string
  path: string
  branch: string | null
  main: boolean
  locked: boolean
  prunable: boolean
}

type WorktreeTarget = Pick<GitWorktree, 'project' | 'path' | 'branch'>

type ScanSlot = { running?: Promise<void>; queued?: Promise<void> }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type RowState = {
  target: WorktreeTarget
  operation?: Worktree['operation']
  error?: string
  deletionFailure?: Worktree['deletionFailure']
  bootstrapFailed?: boolean
}

class BootstrapError extends Error {}

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

// Tools such as envtest install read-only directories, whose entries Git
// cannot unlink. Windows does not restrict deletion by directory mode.
async function makeDirectoriesWritable(path: string): Promise<void> {
  const { mode } = await lstat(path)
  if ((mode & 0o700) !== 0o700) await chmod(path, mode | 0o700)
  const entries = await readdir(path, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => makeDirectoriesWritable(join(path, entry.name))),
  )
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

// Git removes this per-worktree directory with the worktree, and files in it
// never appear as untracked changes.
async function bootstrapLogPath(worktree: string): Promise<string> {
  const directory = await git(worktree, ['rev-parse', '--absolute-git-dir'])
  return join(directory.trim(), 'ade-bootstrap.log')
}

async function runBootstrap(command: string, cwd: string): Promise<void> {
  const path = await bootstrapLogPath(cwd)
  const log = await open(path, 'w', 0o600)
  let failure: string | undefined
  try {
    await log.write(`$ ${command}\n`)
    failure = await new Promise<string | undefined>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: os.userInfo().shell || true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      })
      child.once('error', (error) => resolve(error.message))
      child.once('close', (code, signal) =>
        resolve(
          code === 0
            ? undefined
            : signal
              ? `signal ${signal}`
              : `exit code ${code}`,
        ),
      )
    })
  } finally {
    await log.close()
  }
  // The log holds the output; the row only says where to look.
  if (failure)
    throw new BootstrapError(
      `Bootstrap command failed: ${failure}. Open the bootstrap log for details.`,
    )
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

async function branchRefs(project: string): Promise<string[]> {
  const output = await git(project, [
    'for-each-ref',
    '--format=%(refname)%09%(symref)',
    '--sort=refname',
    'refs/heads/',
    'refs/remotes/',
  ])
  return output
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [ref, symbolic] = line.trimEnd().split('\t')
      return symbolic ? [] : [ref]
    })
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
  private closing = false
  private readonly operations = new Set<Promise<void>>()
  private readonly scans = new Map<string, ScanSlot>()
  private readonly admissions = new Set<Promise<unknown>>()
  private readonly editors: EditorServerLifecycle
  private worktrees: GitWorktree[] = []
  private rows = new Map<string, RowState>()
  private projects = new Map<string, ServerConfig['projects'][number]>()

  private readonly colors: WorktreeColors

  private constructor(editors: EditorServerLifecycle, colors: WorktreeColors) {
    super()
    this.editors = editors
    this.colors = colors
  }

  static async open(
    projects: ServerConfig['projects'],
    editors: EditorServerLifecycle,
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
    await store.apply(worktrees, true)
    return store
  }

  // A synchronous, detached snapshot; listing never invokes Git.
  list(): WorktreeSnapshot {
    return structuredClone(this.snapshot)
  }

  // Resolves once no operation or scan is in flight.
  async settled(): Promise<void> {
    for (;;) {
      const active = [
        ...this.operations,
        ...[...this.scans.values()].flatMap((slot) => [
          slot.running,
          slot.queued,
        ]),
      ].filter(Boolean)
      if (!active.length) return
      await Promise.allSettled(active)
    }
  }

  private accepting(): void {
    if (this.closing) throw new Error('Companion is shutting down.')
  }

  private async admit<T>(operation: () => Promise<T>): Promise<T> {
    this.accepting()
    if (this.operations.size + this.admissions.size >= 32)
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
    await this.settled()
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
      ...(this.rows.get(key)?.bootstrapFailed && { bootstrapFailed: true }),
      ...(this.rows.get(key)?.deletionFailure && {
        deletionFailure: this.rows.get(key)!.deletionFailure,
      }),
      color:
        this.editors.status(target) === 'stopped'
          ? undefined
          : this.colors.get(target),
      editorServer: this.editors.status(target),
      editorServerDetail: this.editors.detail(target),
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

  pathTemplates(): WorktreePathTemplates {
    return {
      pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
      projects: [...this.projects.values()].map(
        ({ mainWorktreePath, worktreePathTemplate }) => ({
          mainWorktreePath,
          worktreePathTemplate,
        }),
      ),
    }
  }

  branches(path: string): Promise<WorktreeBranch[]> {
    this.accepting()
    const project = this.project(path)
    return branchRefs(project).then((refs) => {
      const refNames = new Set(refs)
      return refs.map((ref) => {
        const local = ref.startsWith('refs/heads/')
        const name = ref.slice(
          local ? 'refs/heads/'.length : 'refs/remotes/'.length,
        )
        // Keep suggestions unambiguous with explicit refs and local branches.
        return {
          name:
            name.startsWith('refs/') ||
            (!local && refNames.has(`refs/heads/${name}`))
              ? ref
              : name,
          local,
        }
      })
    })
  }

  // All Git membership changes pass here, in one synchronous step: membership
  // is replaced and editor retention decided before any other request can run.
  // Status-only broadcasts use publish directly, so stopping a process cannot
  // recursively trigger reconciliation.
  private async apply(worktrees: GitWorktree[], force = false): Promise<void> {
    const retained = new Set(worktrees.map(worktreeKey))
    for (const previous of this.worktrees) {
      const key = worktreeKey(previous)
      if (!retained.has(key) && !this.rows.get(key)?.operation)
        this.rows.delete(key)
    }
    this.worktrees = worktrees
    const reconciled = this.editors.retain(worktrees)
    this.publish(force)
    await reconciled
  }

  // Git is the only source of membership. Each project runs one scan at a time
  // and queues at most one more, shared by every request made while it waits.
  // A caller therefore always receives a scan that started after its request.
  private rescan(project: string): Promise<void> {
    let slot = this.scans.get(project)
    if (!slot) this.scans.set(project, (slot = {}))
    if (slot.queued) return slot.queued
    const state = slot
    const next: Promise<void> = (state.running ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        state.queued = undefined
        state.running = next
        try {
          const entries = await scan(project)
          await this.apply(
            this.snapshot.projects.flatMap((path) =>
              path === project
                ? entries
                : this.worktrees.filter((entry) => entry.project === path),
            ),
          )
        } finally {
          state.running = undefined
        }
      })
    state.queued = next
    return next
  }

  refresh(): Promise<WorktreeSnapshot> {
    this.accepting()
    const { revision } = this.snapshot
    // Every refresh broadcasts, even when the scans changed nothing.
    return Promise.all(
      this.snapshot.projects.map((project) => this.rescan(project)),
    ).then(() =>
      this.snapshot.revision === revision ? this.publish() : this.list(),
    )
  }

  private find(input: WorktreeRef): GitWorktree | undefined {
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

  async startEditorServer(input: WorktreeRef): Promise<EditorServerSession> {
    this.accepting()
    const key = worktreeKey(input)
    if (this.rows.get(key)?.operation)
      throw new Error('A worktree operation is still running.')
    // Refused like an operation, so a transient stop leaves no row error.
    if (this.editors.status(input) === 'stopping')
      throw new Error('VS Code is still stopping. Open it once it has stopped.')
    const worktree = this.find(input)
    const state = worktree
      ? {
          target: worktree,
          error: this.rows.get(key)?.error,
          bootstrapFailed: this.rows.get(key)?.bootstrapFailed,
        }
      : undefined
    if (state) {
      this.rows.set(key, state)
    }
    try {
      this.project(input.project)
      const found = this.find(input)
      if (!found || found.prunable)
        throw new Error('Worktree is unavailable. Refresh the list first.')
      await realpath(found.path)
      await this.colors.assign(found)
      // A deletion or rescan may have claimed the worktree during these waits.
      const current = this.find(input)
      if (!current || this.rows.get(key)?.operation)
        throw new Error('Worktree is unavailable. Refresh the list first.')
      return await this.editors.open(
        current,
        this.projects.get(pathKey(current.project))?.chatCommands,
      )
    } catch (error) {
      if (
        state &&
        this.rows.get(key) === state &&
        this.find(input) &&
        this.editors.status(input) !== 'stopping'
      ) {
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

  // Stopping ends a running process; membership and the saved workspace data
  // remain, so a later open starts a fresh process. Startup is not stoppable,
  // so an explicit stop never surfaces as an opening failure.
  async stopEditorServer(input: WorktreeRef): Promise<WorktreeSnapshot> {
    this.accepting()
    const project = this.project(input.project)
    const key = worktreeKey({ ...input, project })
    if (this.rows.get(key)?.operation)
      throw new Error('A worktree operation is still running.')
    const current = this.find({ ...input, project })
    if (!current)
      throw new Error('Worktree is not in the cache. Refresh the list first.')
    if (this.editors.status(current) === 'starting')
      throw new Error('VS Code is still starting. Stop it once it is running.')
    if (this.editors.status(current) === 'stopping')
      throw new Error('VS Code is already stopping.')
    await this.editors.stop(current)
    return this.list()
  }

  // Reserve the row, then run the Git work in the background alongside any
  // other operation. The row keeps its operation until a rescan that started
  // after the work has applied, so membership never trails a cleared row.
  private schedule(
    target: WorktreeTarget,
    operation: NonNullable<Worktree['operation']>,
    run: () => Promise<unknown>,
  ): WorktreeSnapshot {
    const key = worktreeKey(target)
    if (this.rows.get(key)?.operation)
      throw new Error('A worktree operation is already running.')
    if (this.operations.size >= 32)
      throw new Error('Too many pending worktree operations.')
    const state: RowState = { target, operation }
    this.rows.set(key, state)
    const accepted = this.publish()
    // The row owns failures even after the requesting desktop disconnects.
    const work = (async () => {
      let failure: unknown
      try {
        await run()
      } catch (error) {
        failure = error
      }
      const removal =
        failure instanceof WorktreeRemovalError ? failure.details : undefined
      const bootstrapFailed = failure instanceof BootstrapError
      try {
        // Failed hooks and bootstrap commands can still leave a worktree.
        await this.rescan(target.project)
      } catch (error) {
        failure =
          failure === undefined
            ? error
            : new AggregateError(
                [failure, error],
                `${errorMessage(failure)}\nCould not refresh worktrees: ${errorMessage(error)}`,
                { cause: error },
              )
      }
      if (failure === undefined) {
        this.rows.delete(key)
        this.publish()
        return
      }
      state.operation = undefined
      if (removal) state.deletionFailure = removal
      if (bootstrapFailed) state.bootstrapFailed = true
      state.error = errorMessage(failure).slice(0, 4096)
      this.publish()
      this.emit('operationFailed', target, failure)
    })()
    this.operations.add(work)
    void work.finally(() => this.operations.delete(work))
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
      const refs = await branchRefs(project)
      const gitRef = input.baseBranch.trim()
      const localRef = gitRef.startsWith('refs/')
        ? gitRef
        : `refs/heads/${gitRef}`
      const local =
        localRef.startsWith('refs/heads/') && refs.includes(localRef)
      const remoteRef = `refs/remotes/${gitRef}`
      const startRef = local
        ? localRef
        : !gitRef.startsWith('refs/') && refs.includes(remoteRef)
          ? remoteRef
          : gitRef
      if (!branch && !local)
        throw new Error(
          'A new branch name is required unless Git ref names an existing local branch.',
        )
      let args = [
        'worktree',
        'add',
        '--',
        path,
        localRef.slice('refs/heads/'.length),
      ]
      if (branch) {
        if (branch.startsWith('-'))
          throw new Error('Branch names cannot start with a dash.')
        await git(project, ['check-ref-format', `refs/heads/${branch}`])
        const commit = (
          await git(project, [
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${startRef}^{commit}`,
          ])
        ).trim()
        args = ['worktree', 'add', '-b', branch, '--', path, commit]
      }
      // Intentional: creations of the same existing branch are not serialized.
      // Git refuses a branch that is already checked out, but its check is not
      // atomic, so two creations started at the same moment can both succeed.
      await git(project, args)
      const command = this.projects.get(pathKey(project))?.bootstrapCommand
      if (command?.trim()) await runBootstrap(command, path)
    })
  }

  // The log is written beside Git's metadata for the worktree, on this machine.
  async bootstrapLog(
    input: WorktreeRef,
  ): Promise<{ editorServerId: string; path: string }> {
    this.accepting()
    const project = this.project(input.project)
    const current = this.find({ ...input, project })
    if (!current)
      throw new Error('Worktree is not in the cache. Refresh the list first.')
    const path = await bootstrapLogPath(current.path)
    await lstat(path).catch(() => {
      throw new Error('This worktree has no bootstrap log.')
    })
    return { editorServerId: editorServerId(current), path }
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
        if (process.platform !== 'win32')
          // Git reports any directory that still cannot be removed.
          await makeDirectoriesWritable(current.path).catch(() => {})
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
