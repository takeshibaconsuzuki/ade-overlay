import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import Mustache from 'mustache'
import { WORKTREE_DIRTY_ERROR_CODE } from '../../api/server/config'
import { type Logger } from '../../api/server/logger'
import {
  type CreateWorktreeRequest,
  type PreviewWorktreePathRequest,
  type Repository,
  type Worktree,
  type WorktreeCreationState,
  type WorktreeEvent,
  type WorktreeSnapshot,
} from '../../api/server/worktrees'
import { type AppConfigService } from '../config/service'
import { type AppConfig } from '../config/store'
import { getCreationLogsDir } from '../dataDir'
import { HttpError } from '../errors'
import { canonicalizePath, normalizePath, precanonicalizePath } from '../paths'
import { getUserLoginShell } from '../userShell'
import {
  listGitBranches,
  listGitWorktrees,
  runGit,
  type GitWorktree,
} from './git'
import { createWorktreeId } from './ids'

/**
 * Transient state for an async `git worktree add` job. Lives only in the
 * (singleton) registry — it survives a controller-window reopen but is wiped on
 * a full app restart. Never serialized to the wire; the registry projects it
 * into snapshot rows instead.
 */
type CreationJob = {
  worktreeId: string
  mainWorktreePath: string
  newBranch?: string
  baseBranch: string
  bootstrapCommand?: string
  // Canonical target path, computed up front so the job id matches the eventual
  // git-derived id (git reports realpath'd worktree paths).
  canonicalPath: string
  state: 'creating' | 'bootstrapping' | 'succeeded' | 'failed'
  error?: string
  logPath: string
  terminated: boolean
}

function creationLogPathFor(worktreeId: string): string {
  return join(getCreationLogsDir(), `${worktreeId}.log`)
}

/**
 * Max concurrent `worktree-event` listeners before Node warns of a leak. Each
 * open window's SSE stream adds one (launcher, worktrees window, chat, and one
 * per editor window) on top of the two long-lived service listeners (chats,
 * editor), so a normal multi-window session legitimately exceeds Node's default
 * of 10. This is a generous ceiling that still flags a genuine leak (a missing
 * `off()` would climb past it), paired with the add/remove logging in
 * `streamWorktreeEvents` so the live count is auditable even when it stays under
 * the cap.
 */
const WORKTREE_EVENT_MAX_LISTENERS = 64

export class WorktreeRegistry {
  readonly events = new EventEmitter().setMaxListeners(
    WORKTREE_EVENT_MAX_LISTENERS,
  )

  private readonly repositories = new Map<string, TrackedRepository>()
  private readonly creationJobs = new Map<string, CreationJob>()
  private selectedWorktreeId: string | undefined
  private persistRepositoriesTail = Promise.resolve()
  private applyConfigTail = Promise.resolve()

  constructor(
    private readonly log: Logger,
    private readonly appConfig?: AppConfigService,
    // Invoked once a worktree exists on disk, before bootstrap, so agentic
    // coding systems are wired up to call back into the server.
    private readonly configureWorktree?: (worktree: {
      worktreeId: string
      path: string
    }) => Promise<void>,
  ) {}

  async loadRepositories(): Promise<void> {
    // Creation jobs (and their logs) are ephemeral across a full restart; clear
    // any logs left over from a previous run so the directory never accumulates
    // orphaned files.
    await rm(getCreationLogsDir(), { recursive: true, force: true }).catch(
      (error: unknown) => {
        this.log.warn({ err: error }, 'failed to clear creation logs')
      },
    )

    if (!this.appConfig) {
      return
    }

    await this.applyAppConfig(await this.appConfig.read(), {
      emit: false,
      message: 'repositories loaded',
    })
  }

  async reloadConfig(config: AppConfig): Promise<void> {
    const apply = this.applyConfigTail.then(async () => {
      await this.persistRepositoriesTail
      await this.applyAppConfig(config, {
        emit: true,
        message: 'worktree config reloaded',
      })
    })
    this.applyConfigTail = apply.catch(() => undefined)
    await apply
  }

  async addRepository(
    repositoryPath: string,
  ): Promise<{ repository: Repository; snapshot: WorktreeSnapshot }> {
    const worktrees = await listGitWorktrees(repositoryPath, this.log)
    const mainWorktree = worktrees.at(0)

    if (!mainWorktree) {
      throw new HttpError(400, `No Git worktrees found for ${repositoryPath}`)
    }

    const mainWorktreePath = await canonicalizePath(mainWorktree.path)
    const previousRepository = this.repositories.get(mainWorktreePath)
    const repository: TrackedRepository = {
      mainWorktreePath,
      worktreePathTemplate: previousRepository?.worktreePathTemplate,
      bootstrapCommand: previousRepository?.bootstrapCommand,
      preChatCommand: previousRepository?.preChatCommand,
    }

    this.repositories.set(mainWorktreePath, repository)
    try {
      await this.persistRepositories()
    } catch (error) {
      if (previousRepository) {
        this.repositories.set(mainWorktreePath, previousRepository)
      } else {
        this.repositories.delete(mainWorktreePath)
      }

      throw error
    }

    this.log.info({ mainWorktreePath }, 'repository added')

    const publicRepository = toPublicRepository(repository)
    const snapshot = await this.getSnapshot()
    this.emit({
      type: 'repository-added',
      repository: publicRepository,
      snapshot,
    })

    return { repository: publicRepository, snapshot }
  }

  async removeRepository(
    mainWorktreePath: string,
  ): Promise<{ removed: boolean; snapshot: WorktreeSnapshot }> {
    const repositoryKey = await this.findRepositoryKey(mainWorktreePath)
    const repository = repositoryKey
      ? this.repositories.get(repositoryKey)
      : undefined
    const removed = repositoryKey
      ? this.repositories.delete(repositoryKey)
      : false

    if (removed) {
      try {
        await this.persistRepositories()
      } catch (error) {
        if (repositoryKey && repository) {
          this.repositories.set(repositoryKey, repository)
        }

        throw error
      }

      // Drop any transient creation jobs (and logs) for the untracked repo so
      // their rows don't linger after the repository is gone.
      for (const [worktreeId, job] of this.creationJobs) {
        if (job.mainWorktreePath === repositoryKey) {
          this.creationJobs.delete(worktreeId)
          await this.removeCreationLog(job)
        }
      }
    }

    const snapshot = await this.getSnapshot()

    if (removed && repositoryKey) {
      this.log.info({ mainWorktreePath: repositoryKey }, 'repository removed')
      this.emit({
        type: 'repository-removed',
        mainWorktreePath: repositoryKey,
        snapshot,
      })
    }

    return { removed, snapshot }
  }

  async getRepositoryWorktrees(mainWorktreePath: string): Promise<Worktree[]> {
    const repository = await this.getRepository(mainWorktreePath)
    const snapshot = await this.getSnapshot()
    return snapshot.worktrees.filter(
      (worktree) => worktree.mainWorktreePath === repository.mainWorktreePath,
    )
  }

  /**
   * Queue a worktree creation and return immediately with the (stable)
   * pre-minted id and an optimistic `creating` row. The actual `git worktree
   * add` runs in the background via {@link runCreateJob}; clients learn the
   * outcome through the worktree event stream.
   */
  async enqueueCreateWorktree({
    mainWorktreePath,
    newBranch,
    baseBranch,
    worktreePath,
    bootstrap,
  }: CreateWorktreeRequest): Promise<{
    worktreeId: string
    worktree: Worktree
  }> {
    const repository = await this.getRepository(mainWorktreePath)

    let canonicalPath: string
    try {
      canonicalPath = await precanonicalizePath(worktreePath)
    } catch {
      throw new HttpError(
        400,
        `Worktree path parent directory does not exist: ${worktreePath}`,
      )
    }

    const worktreeId = createWorktreeId(canonicalPath)

    const activeJob = this.creationJobs.get(worktreeId)
    if (activeJob && !activeJob.terminated) {
      throw new HttpError(
        409,
        `A worktree is already being created at ${canonicalPath}`,
      )
    }
    if (await this.gitWorktreeExists(repository.mainWorktreePath, worktreeId)) {
      throw new HttpError(409, `Worktree already exists at ${canonicalPath}`)
    }

    const job: CreationJob = {
      worktreeId,
      mainWorktreePath: repository.mainWorktreePath,
      newBranch,
      baseBranch,
      bootstrapCommand: bootstrap ? repository.bootstrapCommand : undefined,
      canonicalPath,
      state: 'creating',
      logPath: creationLogPathFor(worktreeId),
      terminated: false,
    }
    this.creationJobs.set(worktreeId, job)
    await initializeCreationLog(job, bootstrap)

    const snapshot = await this.getSnapshot()
    this.log.info(
      {
        worktreeId,
        path: canonicalPath,
        baseBranch,
        newBranch,
        bootstrap,
      },
      'worktree creation queued',
    )
    this.emit({ type: 'worktree-creation-updated', worktreeId, snapshot })

    void this.runCreateJob(worktreeId)

    const worktree = snapshot.worktrees.find(
      (candidate) => candidate.worktreeId === worktreeId,
    )!
    return { worktreeId, worktree }
  }

  private async runCreateJob(worktreeId: string): Promise<void> {
    const job = this.creationJobs.get(worktreeId)
    if (!job) {
      return
    }

    const args = ['worktree', 'add']
    if (job.newBranch) {
      args.push('-b', job.newBranch)
    }
    args.push(job.canonicalPath, job.baseBranch)

    try {
      await runGit(job.mainWorktreePath, args, this.log, {
        logFilePath: job.logPath,
      })

      if (this.configureWorktree) {
        try {
          await this.configureWorktree({
            worktreeId: job.worktreeId,
            path: job.canonicalPath,
          })
        } catch (error) {
          // Non-fatal: a chat-integration failure should not fail the worktree.
          this.log.warn(
            { worktreeId, err: error },
            'failed to configure worktree chat integration',
          )
        }
      }

      if (job.bootstrapCommand) {
        const current = this.creationJobs.get(worktreeId)
        if (!current) {
          await this.bestEffortRemoveWorktree(job)
          return
        }

        current.state = 'bootstrapping'
        this.log.info({ worktreeId }, 'worktree bootstrap started')
        this.emit({
          type: 'worktree-creation-updated',
          worktreeId,
          snapshot: await this.getSnapshot(),
        })

        await runBootstrapCommand(
          job.bootstrapCommand,
          job.canonicalPath,
          job.logPath,
          this.log,
        )
      }
    } catch (error) {
      const current = this.creationJobs.get(worktreeId)
      if (!current) {
        return
      }
      current.state = 'failed'
      current.terminated = true
      current.error = oneLineError(error)
      this.log.warn({ worktreeId, err: error }, 'worktree creation failed')
      this.emit({
        type: 'worktree-creation-updated',
        worktreeId,
        snapshot: await this.getSnapshot(),
      })
      return
    }

    const current = this.creationJobs.get(worktreeId)
    if (!current) {
      // The job was deleted while git was running; undo the orphaned worktree.
      await this.bestEffortRemoveWorktree(job)
      return
    }

    current.state = 'succeeded'
    current.terminated = true
    this.log.info({ worktreeId, path: job.canonicalPath }, 'worktree created')
    const snapshot = await this.getSnapshot()
    const worktree = snapshot.worktrees.find(
      (candidate) => candidate.worktreeId === worktreeId,
    )
    if (worktree) {
      this.emit({ type: 'worktree-created', worktree, snapshot })
    } else {
      this.emit({ type: 'worktree-creation-updated', worktreeId, snapshot })
    }
  }

  async dismissCreationError(
    worktreeId: string,
  ): Promise<{ snapshot: WorktreeSnapshot }> {
    const job = this.creationJobs.get(worktreeId)
    if (!job) {
      return { snapshot: await this.getSnapshot() }
    }

    if (await this.gitWorktreeExists(job.mainWorktreePath, worktreeId)) {
      // The worktree exists on disk (e.g. a future post-create step failed);
      // clear the error and present a normal, openable row.
      job.state = 'succeeded'
      job.error = undefined
    } else {
      // A `git worktree add` failure leaves nothing on disk; drop the row.
      this.creationJobs.delete(worktreeId)
      await this.removeCreationLog(job)
    }

    const snapshot = await this.getSnapshot()
    this.emit({ type: 'worktree-creation-updated', worktreeId, snapshot })
    return { snapshot }
  }

  getCreationJob(worktreeId: string): CreationJob | undefined {
    return this.creationJobs.get(worktreeId)
  }

  async resolveMainWorktreeId(mainWorktreePath: string): Promise<string> {
    const repository = await this.getRepository(mainWorktreePath)
    return createWorktreeId(repository.mainWorktreePath)
  }

  private async gitWorktreeExists(
    mainWorktreePath: string,
    worktreeId: string,
  ): Promise<boolean> {
    try {
      const worktrees = await listGitWorktrees(mainWorktreePath, this.log)
      return worktrees.some(
        (worktree) => createWorktreeId(worktree.path) === worktreeId,
      )
    } catch {
      return false
    }
  }

  private async bestEffortRemoveWorktree(job: CreationJob): Promise<void> {
    try {
      await runGit(
        job.mainWorktreePath,
        ['worktree', 'remove', '--force', job.canonicalPath],
        this.log,
      )
    } catch (error) {
      this.log.warn(
        { err: error, worktreeId: job.worktreeId },
        'failed to clean up orphaned worktree',
      )
    }
    await this.removeCreationLog(job)
  }

  private async removeCreationLog(job: CreationJob): Promise<void> {
    await rm(job.logPath, { force: true }).catch((error: unknown) => {
      this.log.warn(
        { err: error, worktreeId: job.worktreeId },
        'failed to remove creation log',
      )
    })
  }

  async previewWorktreePath({
    mainWorktreePath,
    newBranch,
    baseBranch,
  }: PreviewWorktreePathRequest): Promise<{ worktreePath: string }> {
    const repository = await this.getRepository(mainWorktreePath)
    const template = repository.worktreePathTemplate
    if (!template) {
      return { worktreePath: '' }
    }

    const branch = newBranch || baseBranch
    return {
      worktreePath: renderWorktreePathTemplate(template, {
        main_worktree_path: repository.mainWorktreePath,
        main_worktree_id: createWorktreeId(repository.mainWorktreePath),
        branch,
      }),
    }
  }

  async listBranches(
    mainWorktreePath: string,
  ): Promise<{ branches: string[] }> {
    const repository = await this.getRepository(mainWorktreePath)
    const branches = await listGitBranches(
      repository.mainWorktreePath,
      this.log,
    )
    return { branches }
  }

  async deleteWorktree(
    worktreeId: string,
    deleteBranch: boolean,
    force = false,
  ): Promise<{ deleted: boolean; branchDeleted: boolean }> {
    const job = this.creationJobs.get(worktreeId)

    // A pending/failed job with no real worktree on disk: drop the transient
    // row instead of asking git to remove a path it doesn't track.
    if (
      job &&
      !(await this.gitWorktreeExists(job.mainWorktreePath, worktreeId))
    ) {
      this.creationJobs.delete(worktreeId)
      await this.removeCreationLog(job)
      const snapshot = await this.getSnapshot()
      this.log.info({ worktreeId }, 'pending worktree removed')
      this.emit({
        type: 'worktree-deleted',
        worktreeId,
        branchDeleted: false,
        snapshot,
      })
      return { deleted: true, branchDeleted: false }
    }

    const worktree = await this.getWorktreeById(worktreeId)

    if (worktree.path === worktree.mainWorktreePath) {
      throw new HttpError(400, 'Cannot delete a tracked main worktree')
    }

    try {
      await runGit(
        worktree.mainWorktreePath,
        ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path],
        this.log,
      )
    } catch (error) {
      // git refuses a plain remove when the worktree has modified or untracked
      // files. Surface a recognizable code so the renderer can offer a force
      // delete instead of treating it as a generic failure.
      if (!force && isDirtyWorktreeError(error)) {
        throw new HttpError(
          409,
          `${worktree.path} has uncommitted or untracked changes.`,
          WORKTREE_DIRTY_ERROR_CODE,
        )
      }
      // A prunable worktree — its `.git` link is gone but git still tracks the
      // path — can't be removed by `git worktree remove`, even with --force
      // ("validation failed, cannot remove working tree: '<path>/.git' does not
      // exist"). `git worktree prune` is the only thing that clears it, so fall
      // back to it; otherwise the row is permanently undeletable (and the path
      // stays blocked, so it can't be recreated either).
      if (worktree.isPrunable || isPrunableWorktreeError(error)) {
        await runGit(worktree.mainWorktreePath, ['worktree', 'prune'], this.log)
        this.log.info(
          { worktreeId, path: worktree.path },
          'pruned worktree after remove failed',
        )
      } else {
        throw error
      }
    }

    let branchDeleted = false
    if (deleteBranch && worktree.branchName) {
      await runGit(
        worktree.mainWorktreePath,
        ['branch', '-D', worktree.branchName],
        this.log,
      )
      branchDeleted = true
    }

    if (job) {
      this.creationJobs.delete(worktreeId)
      await this.removeCreationLog(job)
    }

    const snapshot = await this.getSnapshot()
    this.log.info({ worktreeId, branchDeleted }, 'worktree deleted')
    this.emit({
      type: 'worktree-deleted',
      worktreeId,
      branchDeleted,
      snapshot,
    })

    return { deleted: true, branchDeleted }
  }

  async getSnapshot(): Promise<WorktreeSnapshot> {
    const trackedRepositories = [...this.repositories.values()].sort(
      (left, right) =>
        left.mainWorktreePath.localeCompare(right.mainWorktreePath),
    )
    const worktreeGroups = await Promise.all(
      trackedRepositories.map(async (repository) => {
        try {
          return (
            await listGitWorktrees(repository.mainWorktreePath, this.log)
          ).map((worktree) => ({
            ...worktree,
            mainWorktreePath: repository.mainWorktreePath,
          }))
        } catch (error) {
          this.log.warn(
            { err: error, mainWorktreePath: repository.mainWorktreePath },
            'failed to list repository worktrees',
          )
          return []
        }
      }),
    )

    // Real git worktrees, keyed by id so creation jobs can merge in place.
    const byId = new Map<string, Worktree>(
      worktreeGroups
        .flat()
        .map(toPublicWorktree)
        .map((worktree) => [worktree.worktreeId, worktree]),
    )

    for (const job of this.creationJobs.values()) {
      const gitRow = byId.get(job.worktreeId)
      if (job.state === 'succeeded') {
        // The git row shares this id; flag it ready and keep logs available. If
        // git hasn't surfaced it yet, fall back to the synthetic creating row.
        byId.set(
          job.worktreeId,
          gitRow
            ? { ...gitRow, creationState: 'ready', hasCreationLogs: true }
            : toJobWorktree(job, 'creating'),
        )
        continue
      }
      if (job.state === 'bootstrapping') {
        byId.set(
          job.worktreeId,
          gitRow
            ? {
                ...gitRow,
                creationState: 'bootstrapping',
                hasCreationLogs: true,
                isOpenable: true,
              }
            : toJobWorktree(job, 'bootstrapping'),
        )
        continue
      }
      if (job.state === 'creating') {
        if (!gitRow) {
          byId.set(job.worktreeId, toJobWorktree(job, 'creating'))
        }
        continue
      }
      // failed: there is no git row, surface the failure.
      byId.set(
        job.worktreeId,
        gitRow
          ? {
              ...gitRow,
              creationState: 'failed',
              creationError: job.error,
              hasCreationLogs: true,
              isOpenable: true,
            }
          : toJobWorktree(job, 'failed'),
      )
    }

    const worktrees = [...byId.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    )

    const repositories = trackedRepositories.map(toPublicRepository)
    const selectedWorktreeId = this.selectedWorktreeId
    const selectedExists =
      selectedWorktreeId !== undefined && byId.has(selectedWorktreeId)

    return {
      repositories,
      worktrees,
      selectedWorktreeId: selectedExists ? selectedWorktreeId : undefined,
    }
  }

  async selectWorktree(worktreeId: string): Promise<void> {
    await this.getWorktreeById(worktreeId)
    this.selectedWorktreeId = worktreeId
    await this.appConfig?.writeSelectedWorktreeId(worktreeId)
    const snapshot = await this.getSnapshot()
    this.emit({ type: 'worktree-selected', worktreeId, snapshot })
  }

  private async getRepository(
    mainWorktreePath: string,
  ): Promise<TrackedRepository> {
    const repositoryKey = await this.findRepositoryKey(mainWorktreePath)

    if (!repositoryKey) {
      throw new HttpError(404, `Repository is not tracked: ${mainWorktreePath}`)
    }

    return this.repositories.get(repositoryKey)!
  }

  private async findRepositoryKey(
    mainWorktreePath: string,
  ): Promise<string | undefined> {
    const normalizedPath = normalizePath(mainWorktreePath)

    if (this.repositories.has(normalizedPath)) {
      return normalizedPath
    }

    try {
      const canonicalPath = await canonicalizePath(mainWorktreePath)
      return this.repositories.has(canonicalPath) ? canonicalPath : undefined
    } catch {
      return undefined
    }
  }

  async getWorktreeById(worktreeId: string): Promise<Worktree> {
    const snapshot = await this.getSnapshot()
    const worktree = snapshot.worktrees.find(
      (candidate) => candidate.worktreeId === worktreeId,
    )

    if (!worktree) {
      throw new HttpError(404, `Worktree not found: ${worktreeId}`)
    }

    return worktree
  }

  async getPreChatCommandForWorktree(
    worktreeId: string,
  ): Promise<string | undefined> {
    const worktree = await this.getWorktreeById(worktreeId)
    const repository = await this.getRepository(worktree.mainWorktreePath)
    return repository.preChatCommand
  }

  private emit(event: WorktreeEvent): void {
    this.events.emit('worktree-event', event)
  }

  private async persistRepositories(): Promise<void> {
    if (!this.appConfig) {
      return
    }

    const appConfig = this.appConfig
    const repositories = [...this.repositories.values()]
    const write = this.persistRepositoriesTail.then(() =>
      appConfig.writeRepositories(repositories),
    )
    this.persistRepositoriesTail = write.catch(() => undefined)

    await write
  }

  private async applyAppConfig(
    config: AppConfig,
    {
      emit,
      message,
    }: {
      emit: boolean
      message: string
    },
  ): Promise<void> {
    if (!this.appConfig) {
      return
    }

    const repositories = new Map<string, TrackedRepository>()
    for (const repository of config.repositories) {
      const mainWorktreePath = normalizePath(repository.mainWorktreePath)
      repositories.set(mainWorktreePath, {
        mainWorktreePath,
        worktreePathTemplate: repository.worktreePathTemplate,
        bootstrapCommand: repository.bootstrapCommand,
        preChatCommand: repository.preChatCommand,
      })
    }

    const changed =
      this.selectedWorktreeId !== config.selectedWorktreeId ||
      !repositoriesEqual(this.repositories, repositories)

    this.repositories.clear()
    for (const [mainWorktreePath, repository] of repositories) {
      this.repositories.set(mainWorktreePath, repository)
    }
    this.selectedWorktreeId = config.selectedWorktreeId

    for (const [worktreeId, job] of this.creationJobs) {
      if (!this.repositories.has(job.mainWorktreePath)) {
        this.creationJobs.delete(worktreeId)
        await this.removeCreationLog(job)
      }
    }

    this.log.info(
      {
        configPath: this.appConfig.configPath,
        repositoryCount: this.repositories.size,
      },
      message,
    )

    if (emit && changed) {
      this.events.emit('worktree-snapshot', await this.getSnapshot())
    }
  }
}

type TrackedRepository = Repository & {
  worktreePathTemplate?: string
  preChatCommand?: string
}

function toPublicRepository(repository: TrackedRepository): Repository {
  return {
    mainWorktreePath: repository.mainWorktreePath,
    bootstrapCommand: repository.bootstrapCommand,
  }
}

function repositoriesEqual(
  left: ReadonlyMap<string, TrackedRepository>,
  right: ReadonlyMap<string, TrackedRepository>,
): boolean {
  if (left.size !== right.size) {
    return false
  }

  for (const [mainWorktreePath, leftRepository] of left) {
    const rightRepository = right.get(mainWorktreePath)
    if (
      !rightRepository ||
      leftRepository.worktreePathTemplate !==
        rightRepository.worktreePathTemplate ||
      leftRepository.bootstrapCommand !== rightRepository.bootstrapCommand ||
      leftRepository.preChatCommand !== rightRepository.preChatCommand
    ) {
      return false
    }
  }

  return true
}

function renderWorktreePathTemplate(
  template: string,
  values: Record<string, string>,
): string {
  assertValidWorktreePathTemplate(template, values)
  return Mustache.render(template, values, undefined, { escape: String })
}

function assertValidWorktreePathTemplate(
  template: string,
  values: Record<string, string>,
): void {
  const allowedVariables = new Set(Object.keys(values))
  for (const variable of getTemplateVariables(Mustache.parse(template))) {
    if (!allowedVariables.has(variable)) {
      throw new HttpError(
        400,
        `Unsupported worktree path template variable: ${variable}`,
      )
    }
  }
}

function getTemplateVariables(tokens: Mustache.TemplateSpans): string[] {
  return tokens.flatMap((token) => {
    const symbol = token[0]
    if (symbol === 'text') {
      return []
    }

    if (symbol === 'name' || symbol === '&') {
      return [String(token[1])]
    }

    throw new HttpError(
      400,
      `Unsupported worktree path template syntax: ${symbol}`,
    )
  })
}

function toPublicWorktree(
  worktree: GitWorktree & { mainWorktreePath: string },
): Worktree {
  return {
    worktreeId: createWorktreeId(worktree.path),
    path: worktree.path,
    mainWorktreePath: worktree.mainWorktreePath,
    isMain: worktree.path === worktree.mainWorktreePath,
    head: worktree.head,
    branch: worktree.branch,
    branchName: getBranchName(worktree.branch),
    isBare: worktree.isBare,
    isDetached: worktree.isDetached,
    isPrunable: worktree.isPrunable,
    prunableReason: worktree.prunableReason,
    creationState: 'ready',
    hasCreationLogs: false,
    isOpenable: true,
  }
}

/** Project a transient creation job into a synthetic worktree row. */
function toJobWorktree(
  job: CreationJob,
  creationState: WorktreeCreationState,
): Worktree {
  return {
    worktreeId: job.worktreeId,
    path: job.canonicalPath,
    mainWorktreePath: job.mainWorktreePath,
    isMain: false,
    branchName: job.newBranch ?? job.baseBranch,
    isBare: false,
    isDetached: false,
    isPrunable: false,
    creationState,
    creationError: creationState === 'failed' ? job.error : undefined,
    hasCreationLogs: true,
    isOpenable: false,
  }
}

async function initializeCreationLog(
  job: CreationJob,
  bootstrapRequested: boolean,
): Promise<void> {
  await mkdir(dirname(job.logPath), { recursive: true })
  const lines = [
    `worktree: ${job.canonicalPath}`,
    `base branch: ${job.baseBranch}`,
    job.newBranch && `new branch: ${job.newBranch}`,
    bootstrapRequested &&
      (job.bootstrapCommand
        ? `bootstrap: ${job.bootstrapCommand}`
        : 'bootstrap: requested, no command configured'),
    '',
  ].filter((line): line is string => Boolean(line))
  await appendFile(job.logPath, lines.join('\n'), 'utf8')
}

async function runBootstrapCommand(
  command: string,
  cwd: string,
  logFilePath: string,
  log: Logger,
): Promise<void> {
  await mkdir(dirname(logFilePath), { recursive: true })
  await appendFile(logFilePath, `\n$ ${command}\n`, 'utf8')

  await new Promise<void>((resolve, reject) => {
    const bootstrapShell = getBootstrapShell(command)
    const child = spawn(bootstrapShell.file, bootstrapShell.args, {
      cwd,
      env: process.env,
      shell: bootstrapShell.shell,
    })
    const output = createWriteStream(logFilePath, { flags: 'a' })

    child.stdout?.pipe(output, { end: false })
    child.stderr?.pipe(output, { end: false })

    child.on('error', (error) => {
      output.end(() => {
        reject(new HttpError(400, `Bootstrap command failed: ${error.message}`))
      })
    })

    child.on('close', (code, signal) => {
      const status =
        code === 0
          ? '\nbootstrap exited with code 0\n'
          : signal
            ? `\nbootstrap terminated by signal ${signal}\n`
            : `\nbootstrap exited with code ${code ?? 'unknown'}\n`

      output.end(status, () => {
        if (code === 0) {
          resolve()
          return
        }

        reject(
          new HttpError(
            400,
            signal
              ? `Bootstrap command terminated by signal ${signal}`
              : `Bootstrap command failed with exit code ${code ?? 'unknown'}`,
          ),
        )
      })
    })
  })

  log.info({ cwd }, 'bootstrap command completed')
}

type BootstrapShell = {
  file: string
  args: string[]
  shell?: boolean
}

function getBootstrapShell(command: string): BootstrapShell {
  if (platform() === 'win32') {
    return {
      file: command,
      args: [],
      shell: true,
    }
  }

  const loginShell = getUserLoginShell()
  if (!loginShell) {
    return {
      file: command,
      args: [],
      shell: true,
    }
  }

  return {
    file: loginShell,
    args: ['-lic', command],
  }
}

function getBranchName(branch?: string): string | undefined {
  return branch?.startsWith('refs/heads/')
    ? branch.slice('refs/heads/'.length)
    : undefined
}

/**
 * Detect git's refusal to remove a worktree that still has modified or
 * untracked files, e.g. "contains modified or untracked files, use --force".
 */
function isDirtyWorktreeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /use --force/i.test(message)
}

/**
 * Detect git's refusal to remove a worktree whose `.git` link is missing, e.g.
 * "validation failed, cannot remove working tree: '<path>/.git' does not exist".
 * This is the prunable case `git worktree remove` can't handle — only `prune`
 * can — so it's a backstop for when the snapshot's `isPrunable` flag is stale.
 */
function isPrunableWorktreeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /cannot remove working tree/i.test(message)
}

/**
 * Reduce a git error to a single useful line for the row. Prefers a `fatal:` /
 * `error:` line, then the last non-empty line; the full output lives in the log.
 */
function oneLineError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const highlighted = lines.find((line) => /^(fatal|error):/i.test(line))
  return (highlighted ?? lines.at(-1) ?? 'Worktree creation failed').slice(
    0,
    300,
  )
}
