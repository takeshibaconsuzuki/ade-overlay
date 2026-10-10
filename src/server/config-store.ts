import { once } from 'node:events'
import { resolve } from 'node:path'
import { watch } from 'chokidar'
import { logger } from '../shared/logger'
import { optionsFromFile, type ServerOptions } from './options'

const log = logger.child({ component: 'config-store' })

export interface ConfigStore {
  readonly snapshot: ServerOptions
  setOnChangedListener(
    listener: ((options: ServerOptions) => void) | undefined,
  ): void
  close(): Promise<void>
}

export async function createConfigStore(
  configPath: string,
): Promise<ConfigStore> {
  const path = resolve(configPath)
  let snapshot = await optionsFromFile(path)
  let onChangedListener: ((options: ServerOptions) => void) | undefined
  let pendingReload = Promise.resolve()
  let closed = false
  let closing: Promise<void> | undefined

  const reload = (): Promise<void> => {
    const reading = pendingReload.then(async () => {
      if (closed) return
      log.info({ path }, 'Reloading server configuration')
      const next = await optionsFromFile(path)
      if (closed) return
      snapshot = next
      log.info(
        { path, projectCount: snapshot.projects.length },
        'Server configuration reloaded',
      )
      onChangedListener?.(snapshot)
    })
    pendingReload = reading.catch(() => {})
    return reading
  }
  const watcher = watch(path, {
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
  })
  watcher.on('all', () => {
    if (closed) return
    void reload().catch((error: unknown) => {
      if (!closed) {
        log.error(
          { err: error, path },
          'Failed to reload configuration; keeping last valid configuration',
        )
      }
    })
  })
  watcher.on('error', (error) => {
    log.error({ err: error, path }, 'Configuration watcher failed')
  })

  const close = () => {
    closing ??= (async () => {
      closed = true
      onChangedListener = undefined
      await Promise.all([watcher.close(), pendingReload])
    })()
    return closing
  }
  try {
    await once(watcher, 'ready')
    // Read again after watching starts to cover edits made during watcher setup.
    await reload()
  } catch (error) {
    await close()
    throw error
  }

  return {
    get snapshot() {
      return snapshot
    },
    setOnChangedListener(listener): void {
      onChangedListener = listener
    },
    close,
  }
}
