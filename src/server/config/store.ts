import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import { type Logger } from '../../api/server/logger'
import { getAppDataDir } from '../dataDir'

const RepositoryConfig = z.object({
  mainWorktreePath: z.string().min(1),
  worktreePathTemplate: z.string().min(1).optional(),
  bootstrapCommand: z.string().min(1).optional(),
  preChatCommand: z.string().min(1).optional(),
})

const AppConfig = z
  .object({
    repositories: z.array(RepositoryConfig).default([]),
    selectedWorktreeId: z.string().min(1).optional(),
  })
  .passthrough()

export type RepositoryConfig = z.infer<typeof RepositoryConfig>
export type AppConfig = z.infer<typeof AppConfig>

export class AppConfigStore {
  constructor(
    private readonly log: Logger,
    readonly configPath = getAppConfigPath(),
  ) {}

  async read(): Promise<AppConfig> {
    let rawConfig: string
    try {
      rawConfig = await readFile(this.configPath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { repositories: [] }
      }

      throw error
    }

    let parsedConfig: unknown
    try {
      parsedConfig = JSON.parse(rawConfig)
    } catch (error) {
      this.log.warn(
        { err: error, configPath: this.configPath },
        'app config parse failed',
      )
      return { repositories: [] }
    }

    const result = AppConfig.safeParse(parsedConfig)
    if (!result.success) {
      this.log.warn(
        { err: result.error, configPath: this.configPath },
        'app config validation failed',
      )
      return { repositories: [] }
    }

    return result.data
  }

  async write(config: AppConfig): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true })

    const temporaryPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
    })
    await rename(temporaryPath, this.configPath)
  }

  async writeRepositories(repositories: RepositoryConfig[]): Promise<void> {
    const config = await this.read()
    await this.write({
      ...config,
      repositories: dedupeRepositories(repositories),
    })
  }

  async readSelectedWorktreeId(): Promise<string | undefined> {
    return (await this.read()).selectedWorktreeId
  }

  async writeSelectedWorktreeId(worktreeId: string): Promise<void> {
    const config = await this.read()
    await this.write({
      ...config,
      selectedWorktreeId: worktreeId,
    })
  }
}

export function getAppConfigPath(): string {
  return join(getAppDataDir(), 'config.json')
}

function dedupeRepositories(
  repositories: RepositoryConfig[],
): RepositoryConfig[] {
  return [
    ...new Map(
      repositories.map((repo) => [repo.mainWorktreePath, repo]),
    ).values(),
  ].sort((left, right) =>
    left.mainWorktreePath.localeCompare(right.mainWorktreePath),
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
