import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
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
  kind: 'creation'
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
  completion?: Promise<void>
}

/**
 * Transient state for an async worktree deletion. Like creation jobs, deletion
 * jobs live in the server registry so closing and reopening a renderer does not
 * interrupt them. Failed jobs stay visible until retried or dismissed.
 */
type DeletionJob = {
  kind: 'deletion'
  worktreeId: string
  worktree: Worktree
  creationJob?: CreationJob
  creationCanceled: boolean
  deleteBranch: boolean
  force: boolean
  state: 'deleting' | 'failed' | 'branch-failed' | 'deleted'
  error?: string
  errorCode?: string
}

type LifecycleJob = CreationJob | DeletionJob

// A single discriminated map owns every transient worktree lifecycle. Creation
// and deletion can transition ownership, but they can never independently
// publish rows or cleanup events for the same opaque id.

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
  private readonly lifecycleJobs = new Map<string, LifecycleJob>()
  private readonly lifecycleReservations = new Map<
    string,
    LifecycleJob['kind']
  >()
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
    private readonly runGitCommand: typeof runGit = runGit,
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
      const normalizedWorktreePath = normalizePath(worktreePath)
      await mkdir(dirname(normalizedWorktreePath), { recursive: true })
      canonicalPath = await precanonicalizePath(normalizedWorktreePath)
    } catch (error) {
      throw new HttpError(
        400,
        `Could not prepare worktree path ${worktreePath}: ${oneLineError(error)}`,
      )
    }

    const worktreeId = createWorktreeId(canonicalPath)

    const lifecycleJob = this.lifecycleJobs.get(worktreeId)
    const reservation = this.lifecycleReservations.get(worktreeId)
    if (lifecycleJob?.kind === 'deletion' || reservation === 'deletion') {
      throw new HttpError(
        409,
        `Worktree deletion still owns path ${canonicalPath}`,
      )
    }
    if (
      reservation === 'creation' ||
      (lifecycleJob?.kind === 'creation' && !lifecycleJob.terminated)
    ) {
      throw new HttpError(
        409,
        `A worktree is already being created at ${canonicalPath}`,
      )
    }
    this.lifecycleReservations.set(worktreeId, 'creation')

    try {
      if (
        await this.gitWorktreeExists(repository.mainWorktreePath, worktreeId)
      ) {
        throw new HttpError(409, `Worktree already exists at ${canonicalPath}`)
      }

      const job: CreationJob = {
        kind: 'creation',
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
      await initializeCreationLog(job, bootstrap)
      this.lifecycleJobs.set(worktreeId, job)

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

      job.completion = this.runCreateJob(job)
      void job.completion

      const worktree = snapshot.worktrees.find(
        (candidate) => candidate.worktreeId === worktreeId,
      )!
      return { worktreeId, worktree }
    } finally {
      this.lifecycleReservations.delete(worktreeId)
    }
  }

  private async runCreateJob(job: CreationJob): Promise<void> {
    const { worktreeId } = job

    const args = ['worktree', 'add']
    if (job.newBranch) {
      args.push('-b', job.newBranch)
    }
    args.push(job.canonicalPath, job.baseBranch)

    try {
      await this.runGitCommand(job.mainWorktreePath, args, this.log, {
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
        if (!this.retainsCreationJob(job)) {
          await this.bestEffortRemoveWorktree(job)
          return
        }

        job.state = 'bootstrapping'
        this.log.info({ worktreeId }, 'worktree bootstrap started')
        if (this.lifecycleJobs.get(worktreeId) === job) {
          this.emit({
            type: 'worktree-creation-updated',
            worktreeId,
            snapshot: await this.getSnapshot(),
          })
        }

        await runBootstrapCommand(
          job.bootstrapCommand,
          job.canonicalPath,
          job.logPath,
          this.log,
        )
      }
    } catch (error) {
      job.state = 'failed'
      job.terminated = true
      job.error = oneLineError(error)
      if (!this.retainsCreationJob(job)) {
        return
      }
      this.log.warn({ worktreeId, err: error }, 'worktree creation failed')
      if (this.lifecycleJobs.get(worktreeId) === job) {
        this.emit({
          type: 'worktree-creation-updated',
          worktreeId,
          snapshot: await this.getSnapshot(),
        })
      }
      return
    }

    if (!this.retainsCreationJob(job)) {
      // The job was deleted while git was running; undo the orphaned worktree.
      await this.bestEffortRemoveWorktree(job)
      return
    }

    job.state = 'succeeded'
    job.terminated = true
    this.log.info({ worktreeId, path: job.canonicalPath }, 'worktree created')
    if (this.lifecycleJobs.get(worktreeId) !== job) {
      return
    }
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

  private retainsCreationJob(job: CreationJob): boolean {
    const owner = this.lifecycleJobs.get(job.worktreeId)
    return (
      owner === job ||
      (owner?.kind === 'deletion' &&
        owner.creationJob === job &&
        !owner.creationCanceled)
    )
  }

  async dismissCreationError(
    worktreeId: string,
  ): Promise<{ snapshot: WorktreeSnapshot }> {
    const lifecycleJob = this.lifecycleJobs.get(worktreeId)
    if (lifecycleJob?.kind !== 'creation') {
      return { snapshot: await this.getSnapshot() }
    }
    const job = lifecycleJob

    if (await this.gitWorktreeExists(job.mainWorktreePath, worktreeId)) {
      // The worktree exists on disk (e.g. a future post-create step failed);
      // clear the error and present a normal, openable row.
      job.state = 'succeeded'
      job.error = undefined
    } else {
      // A `git worktree add` failure leaves nothing on disk; drop the row.
      this.lifecycleJobs.delete(worktreeId)
      await this.removeCreationLog(job)
    }

    const snapshot = await this.getSnapshot()
    this.emit({ type: 'worktree-creation-updated', worktreeId, snapshot })
    return { snapshot }
  }

  getCreationJob(worktreeId: string): CreationJob | undefined {
    const job = this.lifecycleJobs.get(worktreeId)
    return job ? lifecycleCreationJob(job) : undefined
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
      await this.runGitCommand(
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

  /**
   * Register a deletion job and return as soon as its `deleting` snapshot has
   * been emitted. The editor shutdown and Git commands run independently of
   * the HTTP request that enqueued the job.
   */
  async enqueueDeleteWorktree(
    worktreeId: string,
    deleteBranch: boolean,
    force = false,
    beforeDelete?: () => Promise<void> | undefined,
  ): Promise<{ worktreeId: string; worktree: Worktree }> {
    const lifecycleJob = this.lifecycleJobs.get(worktreeId)
    const activeJob =
      lifecycleJob?.kind === 'deletion' ? lifecycleJob : undefined
    const reservation = this.lifecycleReservations.get(worktreeId)
    if (reservation === 'creation') {
      throw new HttpError(
        409,
        `Worktree creation is still being queued: ${worktreeId}`,
      )
    }
    if (activeJob?.state === 'branch-failed') {
      throw new HttpError(
        409,
        `Worktree is already deleted but branch deletion failed: ${worktreeId}`,
      )
    }
    if (
      activeJob?.state === 'deleting' ||
      activeJob?.state === 'deleted' ||
      reservation === 'deletion'
    ) {
      throw new HttpError(
        409,
        `Worktree deletion is already running: ${worktreeId}`,
      )
    }
    this.lifecycleReservations.set(worktreeId, 'deletion')

    try {
      const worktree = await this.getWorktreeById(worktreeId)
      if (worktree.path === worktree.mainWorktreePath) {
        throw new HttpError(400, 'Cannot delete a tracked main worktree')
      }

      const job: DeletionJob = {
        kind: 'deletion',
        worktreeId,
        worktree: withoutDeletionState(worktree),
        creationJob: lifecycleJob
          ? lifecycleCreationJob(lifecycleJob)
          : undefined,
        creationCanceled: false,
        deleteBranch,
        force,
        state: 'deleting',
      }
      this.lifecycleJobs.set(worktreeId, job)

      const snapshot = await this.getSnapshot()
      const queuedWorktree = snapshot.worktrees.find(
        (candidate) => candidate.worktreeId === worktreeId,
      )!
      this.log.info(
        { worktreeId, deleteBranch, force },
        'worktree deletion queued',
      )
      this.emit({
        type: 'worktree-deletion-updated',
        worktreeId,
        snapshot,
      })

      void this.runDeleteJob(job, beforeDelete)
      return { worktreeId, worktree: queuedWorktree }
    } finally {
      this.lifecycleReservations.delete(worktreeId)
    }
  }

  async dismissDeletionError(
    worktreeId: string,
  ): Promise<{ snapshot: WorktreeSnapshot }> {
    const lifecycleJob = this.lifecycleJobs.get(worktreeId)
    if (
      lifecycleJob?.kind === 'deletion' &&
      (lifecycleJob.state === 'failed' ||
        lifecycleJob.state === 'branch-failed')
    ) {
      if (lifecycleJob.state === 'failed' && lifecycleJob.creationJob) {
        this.lifecycleJobs.set(worktreeId, lifecycleJob.creationJob)
      } else {
        this.lifecycleJobs.delete(worktreeId)
      }
    }

    const snapshot = await this.getSnapshot()
    this.emit({ type: 'worktree-deletion-updated', worktreeId, snapshot })
    return { snapshot }
  }

  private async runDeleteJob(
    job: DeletionJob,
    beforeDelete?: () => Promise<void> | undefined,
  ): Promise<void> {
    let result: { branchDeleted: boolean; branchDeletionError?: string }
    try {
      await beforeDelete?.()
      job.creationCanceled = true
      result = await this.performDeleteWorktree(job)
    } catch (error) {
      await this.recordDeletionFailure(job, error)
      return
    }

    if (this.lifecycleJobs.get(job.worktreeId) !== job) {
      return
    }

    const { branchDeleted, branchDeletionError } = result
    if (branchDeletionError) {
      job.state = 'branch-failed'
      job.error = branchDeletionError
      job.errorCode = undefined
    } else {
      // Keep ownership through event delivery so a replacement creation cannot
      // be claimed before consumers process the old deletion.
      job.state = 'deleted'
    }

    try {
      const snapshot = await this.getSnapshot()
      this.log.info(
        { worktreeId: job.worktreeId, branchDeleted, branchDeletionError },
        'worktree deleted',
      )
      this.emit({
        type: 'worktree-deleted',
        worktreeId: job.worktreeId,
        branchDeleted,
        snapshot,
      })
    } catch (error) {
      this.log.error(
        { worktreeId: job.worktreeId, err: error },
        'failed to publish completed worktree deletion',
      )
    } finally {
      if (
        job.state === 'deleted' &&
        this.lifecycleJobs.get(job.worktreeId) === job
      ) {
        this.lifecycleJobs.delete(job.worktreeId)
      }
    }
  }

  private async recordDeletionFailure(
    job: DeletionJob,
    error: unknown,
  ): Promise<void> {
    if (this.lifecycleJobs.get(job.worktreeId) !== job) {
      return
    }

    job.state = 'failed'
    job.error = oneLineError(error, 'Worktree deletion failed')
    job.errorCode = error instanceof HttpError ? error.code : undefined
    this.log.warn(
      { worktreeId: job.worktreeId, err: error },
      'worktree deletion failed',
    )
    this.emit({
      type: 'worktree-deletion-updated',
      worktreeId: job.worktreeId,
      snapshot: await this.getSnapshot(),
    })
  }

  private async performDeleteWorktree(
    deletionJob: DeletionJob,
  ): Promise<{ branchDeleted: boolean; branchDeletionError?: string }> {
    const { worktreeId, worktree, deleteBranch, force } = deletionJob
    const creationJob = deletionJob.creationJob

    // A deletion atomically supersedes creation ownership. Wait for an
    // in-flight add/bootstrap to observe that ownership change and clean up any
    // worktree it produced before publishing the final deletion event.
    if (creationJob?.completion && !creationJob.terminated) {
      await creationJob.completion
    }

    // A pending/failed job with no real worktree on disk: drop the transient
    // row instead of asking git to remove a path it doesn't track.
    if (
      creationJob &&
      !(await this.gitWorktreeExists(creationJob.mainWorktreePath, worktreeId))
    ) {
      await this.removeCreationLog(creationJob)
      deletionJob.creationJob = undefined
      return { branchDeleted: false }
    }

    try {
      await this.runGitCommand(
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
        await this.runGitCommand(
          worktree.mainWorktreePath,
          ['worktree', 'prune'],
          this.log,
        )
        this.log.info(
          { worktreeId, path: worktree.path },
          'pruned worktree after remove failed',
        )
      } else {
        throw error
      }
    }

    let branchDeleted = false
    let branchDeletionError: string | undefined
    if (deleteBranch && worktree.branchName) {
      try {
        await this.runGitCommand(
          worktree.mainWorktreePath,
          ['branch', '-D', worktree.branchName],
          this.log,
        )
        branchDeleted = true
      } catch (error) {
        branchDeletionError = oneLineError(error, 'Branch deletion failed')
        this.log.warn(
          {
            err: error,
            worktreeId,
            branchName: worktree.branchName,
          },
          'worktree removed but branch deletion failed',
        )
      }
    }

    if (creationJob) {
      await this.removeCreationLog(creationJob)
      deletionJob.creationJob = undefined
    }

    return { branchDeleted, branchDeletionError }
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

    // Repository tracking controls snapshot visibility, not lifecycle
    // ownership. A job can still be draining after its repository is
    // untracked, and must retain its id until it reaches its normal terminal
    // transition. Re-adding the repository makes retained state visible again.
    for (const job of this.lifecycleJobs.values()) {
      if (!this.repositories.has(lifecycleMainWorktreePath(job))) {
        continue
      }
      if (job.kind === 'creation') {
        projectCreationJob(byId, job)
      } else {
        projectDeletionJob(byId, job)
      }
    }

    const worktrees = [...byId.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    )

    const repositories = trackedRepositories.map(toPublicRepository)
    const selectedWorktreeId = this.selectedWorktreeId
    const selectedWorktree = selectedWorktreeId
      ? byId.get(selectedWorktreeId)
      : undefined
    const selectedIsOpenable = selectedWorktree?.isOpenable === true

    return {
      repositories,
      worktrees,
      selectedWorktreeId: selectedIsOpenable ? selectedWorktreeId : undefined,
    }
  }

  async selectWorktree(worktreeId: string): Promise<void> {
    await this.getOpenableWorktreeById(worktreeId)
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

  async getOpenableWorktreeById(worktreeId: string): Promise<Worktree> {
    const worktree = await this.getWorktreeById(worktreeId)
    if (!worktree.isOpenable) {
      throw new HttpError(409, `Worktree is not openable: ${worktreeId}`)
    }
    return worktree
  }

  async findWorktreeByPath(path: string): Promise<Worktree | undefined> {
    const normalizedPath = normalizePath(path)
    const snapshot = await this.getSnapshot()
    const matches = snapshot.worktrees
      .filter((worktree) => isSameOrChildPath(normalizedPath, worktree.path))
      .sort((left, right) => right.path.length - left.path.length)
    return matches[0]
  }

  async getPreChatCommandForWorktree(
    worktreeId: string,
  ): Promise<string | undefined> {
    const worktree = await this.getOpenableWorktreeById(worktreeId)
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

function lifecycleCreationJob(job: LifecycleJob): CreationJob | undefined {
  return job.kind === 'creation' ? job : job.creationJob
}

function lifecycleMainWorktreePath(job: LifecycleJob): string {
  return job.kind === 'creation'
    ? job.mainWorktreePath
    : job.worktree.mainWorktreePath
}

function projectCreationJob(
  byId: Map<string, Worktree>,
  job: CreationJob,
): void {
  const gitRow = byId.get(job.worktreeId)
  if (job.state === 'succeeded') {
    // The git row shares this id; flag it ready and keep logs available. If git
    // hasn't surfaced it yet, fall back to the synthetic creating row.
    byId.set(
      job.worktreeId,
      gitRow
        ? { ...gitRow, creationState: 'ready', hasCreationLogs: true }
        : toJobWorktree(job, 'creating'),
    )
    return
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
    return
  }
  if (job.state === 'creating') {
    if (!gitRow) {
      byId.set(job.worktreeId, toJobWorktree(job, 'creating'))
    }
    return
  }

  // A failed add has no Git row; retain its synthetic, non-openable row.
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

function projectDeletionJob(
  byId: Map<string, Worktree>,
  job: DeletionJob,
): void {
  if (job.state === 'deleted') {
    byId.delete(job.worktreeId)
    return
  }

  const gitRow = byId.get(job.worktreeId)
  const worktree = gitRow ?? job.worktree
  byId.set(job.worktreeId, {
    ...worktree,
    deletionState: job.state,
    deletionError: job.error,
    deletionErrorCode: job.errorCode,
    deletionDeleteBranch: job.deleteBranch,
    isOpenable: job.state === 'failed' && worktree.isOpenable,
  })
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
    name: getWorktreeName(worktree.path, getBranchName(worktree.branch)),
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

function withoutDeletionState(worktree: Worktree): Worktree {
  const {
    deletionState: _deletionState,
    deletionError: _deletionError,
    deletionErrorCode: _deletionErrorCode,
    deletionDeleteBranch: _deletionDeleteBranch,
    ...readyWorktree
  } = worktree
  return readyWorktree
}

/** Project a transient creation job into a synthetic worktree row. */
function toJobWorktree(
  job: CreationJob,
  creationState: WorktreeCreationState,
): Worktree {
  const branchName = job.newBranch ?? job.baseBranch
  return {
    worktreeId: job.worktreeId,
    name: getWorktreeName(job.canonicalPath, branchName),
    path: job.canonicalPath,
    mainWorktreePath: job.mainWorktreePath,
    isMain: false,
    branchName,
    isBare: false,
    isDetached: false,
    isPrunable: false,
    creationState,
    creationError: creationState === 'failed' ? job.error : undefined,
    hasCreationLogs: true,
    isOpenable: false,
  }
}

function getWorktreeName(path: string, branchName?: string): string {
  return basename(path) || branchName || path
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

function isSameOrChildPath(path: string, parentPath: string): boolean {
  const relativePath = relative(normalizePath(parentPath), path)
  return (
    relativePath === '' ||
    (!!relativePath &&
      !relativePath.startsWith('..') &&
      !isAbsolute(relativePath))
  )
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
function oneLineError(
  error: unknown,
  fallback = 'Worktree creation failed',
): string {
  const message = error instanceof Error ? error.message : String(error)
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const highlighted = lines.find((line) => /^(fatal|error):/i.test(line))
  return (highlighted ?? lines.at(-1) ?? fallback).slice(0, 300)
}
