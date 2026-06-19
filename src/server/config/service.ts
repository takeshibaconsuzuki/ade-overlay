import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { type Logger } from '../../api/server/logger'
import { AppConfigStore, type AppConfig, type RepositoryConfig } from './store'

export const APP_CONFIG_EVENT = {
  configReloaded: 'config-reloaded',
} as const

export type AppConfigReloadedEvent = {
  type: typeof APP_CONFIG_EVENT.configReloaded
  config: AppConfig
}

export class AppConfigService {
  readonly events = new EventEmitter()

  private watcher: FSWatcher | undefined
  private debounceTimer: NodeJS.Timeout | undefined
  private reloadTail = Promise.resolve()

  constructor(
    private readonly log: Logger,
    private readonly store = new AppConfigStore(log),
  ) {}

  get configPath(): string {
    return this.store.configPath
  }

  read(): Promise<AppConfig> {
    return this.store.read()
  }

  writeRepositories(repositories: RepositoryConfig[]): Promise<void> {
    return this.store.writeRepositories(repositories)
  }

  writeSelectedWorktreeId(worktreeId: string): Promise<void> {
    return this.store.writeSelectedWorktreeId(worktreeId)
  }

  async startWatching(): Promise<void> {
    if (this.watcher) {
      return
    }

    const configDir = dirname(this.configPath)
    const configFile = basename(this.configPath)
    await mkdir(configDir, { recursive: true })

    this.watcher = watch(configDir, (_eventType, filename) => {
      const changedFile = filename ?? undefined
      if (changedFile && changedFile !== configFile) {
        return
      }
      this.scheduleReload()
    })

    this.watcher.on('error', (error) => {
      this.log.warn(
        { err: error, configPath: this.configPath },
        'app config watcher failed',
      )
    })
    this.log.info({ configPath: this.configPath }, 'watching app config')
  }

  shutdown(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    this.watcher?.close()
    this.watcher = undefined
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.reloadFromDisk().catch((error: unknown) => {
        this.log.warn(
          { err: error, configPath: this.configPath },
          'app config reload failed',
        )
      })
    }, 100)
  }

  private async reloadFromDisk(): Promise<void> {
    const reload = this.reloadTail.then(async () => {
      const config = await this.store.read()
      this.log.info(
        {
          configPath: this.configPath,
          repositoryCount: config.repositories.length,
        },
        'app config reloaded',
      )
      this.events.emit(APP_CONFIG_EVENT.configReloaded, {
        type: APP_CONFIG_EVENT.configReloaded,
        config,
      } satisfies AppConfigReloadedEvent)
    })
    this.reloadTail = reload.catch(() => undefined)
    await reload
  }
}
