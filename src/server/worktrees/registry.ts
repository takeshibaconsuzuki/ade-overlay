import { EventEmitter } from 'node:events'
import Mustache from 'mustache'
import { type Logger } from '../../api/server/logger'
import { type AppConfigStore } from '../appConfig'
import { HttpError } from '../errors'
import {
  type GitWorktree,
  listGitBranches,
  listGitWorktrees,
  runGit,
} from './git'
import { canonicalizePath, normalizePath } from '../paths'
import { createWorktreeId } from './ids'
import {
  type CreateWorktreeRequest,
  type PreviewWorktreePathRequest,
  type Repository,
  type Worktree,
  type WorktreeEvent,
  type WorktreeSnapshot,
} from './schemas'

export class WorktreeRegistry {
  readonly events = new EventEmitter()

  private readonly repositories = new Map<string, TrackedRepository>()
  private persistRepositoriesTail = Promise.resolve()

  constructor(
    private readonly log: Logger,
    private readonly appConfig?: AppConfigStore,
  ) {}

  async loadRepositories(): Promise<void> {
    if (!this.appConfig) {
      return
    }

    const config = await this.appConfig.read()
    this.repositories.clear()

    for (const repository of config.repositories) {
      const mainWorktreePath = normalizePath(repository.mainWorktreePath)
      this.repositories.set(mainWorktreePath, {
        mainWorktreePath,
        worktreePathTemplate: repository.worktreePathTemplate,
      })
    }

    this.log.info(
      {
        configPath: this.appConfig.configPath,
        repositoryCount: this.repositories.size,
      },
      'repositories loaded',
    )
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

  async createWorktree({
    mainWorktreePath,
    newBranch,
    baseBranch,
    worktreePath,
  }: CreateWorktreeRequest): Promise<{
    worktreeId: string
    worktree: Worktree
  }> {
    const repository = await this.getRepository(mainWorktreePath)
    const args = ['worktree', 'add']

    if (newBranch) {
      args.push('-b', newBranch)
    }

    args.push(normalizePath(worktreePath), baseBranch)
    await runGit(repository.mainWorktreePath, args, this.log)

    // Canonicalize as soon as the path exists on disk (realpath requires it),
    // then key everything off the canonical path.
    const targetPath = await canonicalizePath(worktreePath)
    const worktreeId = createWorktreeId(targetPath)
    const worktree = await this.getWorktreeById(worktreeId)
    const snapshot = await this.getSnapshot()

    this.log.info(
      { worktreeId, path: targetPath, branchName: worktree.branchName },
      'worktree created',
    )
    this.emit({
      type: 'worktree-created',
      worktree,
      snapshot,
    })

    return { worktreeId, worktree }
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
  ): Promise<{ deleted: boolean; branchDeleted: boolean }> {
    const worktree = await this.getWorktreeById(worktreeId)

    if (worktree.path === worktree.mainWorktreePath) {
      throw new HttpError(400, 'Cannot delete a tracked main worktree')
    }

    await runGit(
      worktree.mainWorktreePath,
      ['worktree', 'remove', worktree.path],
      this.log,
    )

    let branchDeleted = false
    if (deleteBranch && worktree.branchName) {
      await runGit(
        worktree.mainWorktreePath,
        ['branch', '-D', worktree.branchName],
        this.log,
      )
      branchDeleted = true
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

    const worktrees = worktreeGroups
      .flat()
      .map(toPublicWorktree)
      .sort((left, right) => left.path.localeCompare(right.path))

    const repositories = trackedRepositories.map(toPublicRepository)

    return { repositories, worktrees }
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
}

type TrackedRepository = Repository & {
  worktreePathTemplate?: string
}

function toPublicRepository(repository: TrackedRepository): Repository {
  return {
    mainWorktreePath: repository.mainWorktreePath,
  }
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
    head: worktree.head,
    branch: worktree.branch,
    branchName: getBranchName(worktree.branch),
    isBare: worktree.isBare,
    isDetached: worktree.isDetached,
    isPrunable: worktree.isPrunable,
    prunableReason: worktree.prunableReason,
  }
}

function getBranchName(branch?: string): string | undefined {
  return branch?.startsWith('refs/heads/')
    ? branch.slice('refs/heads/'.length)
    : undefined
}
