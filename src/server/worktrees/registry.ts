import { EventEmitter } from 'node:events'
import { type Logger } from '../../api/server/logger'
import { HttpError } from '../errors'
import { type GitWorktree, listGitWorktrees, runGit } from './git'
import { canonicalizePath, normalizePath } from '../paths'
import { createWorktreeId } from './ids'
import {
  type CreateWorktreeRequest,
  type Repository,
  type Worktree,
  type WorktreeEvent,
  type WorktreeSnapshot,
} from './schemas'

export class WorktreeRegistry {
  readonly events = new EventEmitter()

  private readonly repositories = new Map<string, Repository>()

  constructor(private readonly log: Logger) {}

  async addRepository(
    repositoryPath: string,
  ): Promise<{ repository: Repository; snapshot: WorktreeSnapshot }> {
    const worktrees = await listGitWorktrees(repositoryPath, this.log)
    const mainWorktree = worktrees.at(0)

    if (!mainWorktree) {
      throw new HttpError(400, `No Git worktrees found for ${repositoryPath}`)
    }

    const mainWorktreePath = await canonicalizePath(mainWorktree.path)
    const repository = { mainWorktreePath }

    this.repositories.set(mainWorktreePath, repository)
    this.log.info({ mainWorktreePath }, 'repository added')

    const snapshot = await this.getSnapshot()
    this.emit({
      type: 'repository-added',
      repository,
      snapshot,
    })

    return { repository, snapshot }
  }

  async removeRepository(
    mainWorktreePath: string,
  ): Promise<{ removed: boolean; snapshot: WorktreeSnapshot }> {
    const repositoryKey = await this.findRepositoryKey(mainWorktreePath)
    const removed = repositoryKey
      ? this.repositories.delete(repositoryKey)
      : false
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
    const repositories = [...this.repositories.values()].sort((left, right) =>
      left.mainWorktreePath.localeCompare(right.mainWorktreePath),
    )
    const worktreeGroups = await Promise.all(
      repositories.map(async (repository) =>
        (await listGitWorktrees(repository.mainWorktreePath, this.log)).map(
          (worktree) => ({
            ...worktree,
            mainWorktreePath: repository.mainWorktreePath,
          }),
        ),
      ),
    )

    const worktrees = worktreeGroups
      .flat()
      .map(toPublicWorktree)
      .sort((left, right) => left.path.localeCompare(right.path))

    return { repositories, worktrees }
  }

  private async getRepository(mainWorktreePath: string): Promise<Repository> {
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
