import { once } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import writeFileAtomic from 'write-file-atomic'
import { isVscodeSettingsDocument } from '../shared/vscode-utils'
import { logger } from '../shared/logger'

const log = logger.child({ component: 'settings-store' })

export interface SettingsStore {
  // null means the host document is unreadable or invalid; both directions wait for a valid host file.
  readonly snapshot: string | null
  setOnChangedListener(
    listener: ((content: string | null) => void) | undefined,
  ): void
  write(content: string): Promise<void>
  close(): Promise<void>
}

export class VscodeSettingsStore implements SettingsStore {
  private readonly watcher: FSWatcher
  private content: string | null = null
  private listener: ((content: string | null) => void) | undefined
  private pending = Promise.resolve()
  private closed = false
  private closing: Promise<void> | undefined

  private constructor(private readonly path: string) {
    this.watcher = watch(path, {
      ignoreInitial: true,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    })
    this.watcher.on('all', () => {
      if (!this.closed) void this.enqueue(() => this.reload())
    })
    this.watcher.on('error', (error) => {
      this.publish(null)
      log.error({ err: error, path }, 'Settings watcher failed')
    })
  }

  static async open(settingsFile: string): Promise<VscodeSettingsStore> {
    const path = resolve(settingsFile)
    // Chokidar needs an existing parent to observe a settings file created later.
    await mkdir(dirname(path), { recursive: true })
    const store = new VscodeSettingsStore(path)
    try {
      await once(store.watcher, 'ready')
      await store.enqueue(() => store.reload())
      return store
    } catch (error) {
      await store.close()
      throw error
    }
  }

  get snapshot(): string | null {
    return this.content
  }

  setOnChangedListener(
    listener: ((content: string | null) => void) | undefined,
  ): void {
    this.listener = listener
  }

  write(content: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isVscodeSettingsDocument(content))
        throw new Error('Settings must be a valid JSONC object')
      // Check the file again: an editor may have written invalid JSON before its watcher event arrives.
      await this.reload()
      if (this.content === null)
        throw new Error('Host settings are unavailable or invalid')
      if (content === this.content) return
      await mkdir(dirname(this.path), { recursive: true })
      await writeFileAtomic(this.path, content, { encoding: 'utf8' })
      this.publish(content)
    })
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true
      this.listener = undefined
      await Promise.all([this.watcher.close(), this.pending])
    })()
    return this.closing
  }

  private publish(content: string | null): void {
    if (this.content === content || this.closed) return
    this.content = content
    this.listener?.(content)
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Settings store closed'))
    const task = this.pending.then(action)
    this.pending = task.catch(() => {})
    return task
  }

  private async read(): Promise<string> {
    try {
      return await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}\n'
      throw error
    }
  }

  private async reload(): Promise<void> {
    try {
      const content = await this.read()
      if (!isVscodeSettingsDocument(content))
        throw new Error('Host settings must be a valid JSONC object')
      this.publish(content)
    } catch (error) {
      this.publish(null)
      log.warn(
        { err: error, path: this.path },
        'Settings synchronization is waiting for a valid host document',
      )
    }
  }
}
