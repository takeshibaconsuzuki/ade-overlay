import { mkdir, readFile, stat, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { Logger } from 'pino'
import {
  MAX_SETTINGS_BYTES,
  settingsSnapshotSchema,
  SettingsSnapshot,
} from '../shared/editor-settings.ts'

// One queue for the companion account's file, shared by every worktree/client.
export class SettingsSync {
  private pending: Promise<unknown> = Promise.resolve()
  readonly path: string
  private readonly logger: Logger
  constructor(path: string, logger: Logger) {
    this.path = path
    this.logger = logger
  }

  async read(): Promise<SettingsSnapshot> {
    try {
      const before = await stat(this.path)
      if (before.size > MAX_SETTINGS_BYTES)
        throw new Error('VS Code settings exceed 1 MiB.')
      const content = await readFile(this.path, 'utf8')
      const after = await stat(this.path)
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
        throw new Error(
          'VS Code settings changed while reading; retrying next cycle.',
        )
      return new SettingsSnapshot(content, after.mtimeMs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return new SettingsSnapshot('{}\n', 0)
    }
  }

  sync(input: unknown): Promise<SettingsSnapshot> {
    const incoming = settingsSnapshotSchema.parse(input)
    const operation = this.pending.then(async () => {
      const local = await this.read()
      // Equal timestamps deterministically favor the companion copy.
      if (incoming.mtime <= local.mtime) return local
      // Recheck before replacing: an external desktop editor can save at any time.
      const current = await this.read()
      if (!current.equals(local))
        throw new Error(
          'VS Code settings changed before writing; retrying next cycle.',
        )
      await this.write(incoming)
      this.logger.debug(
        { direction: 'browser-to-local' },
        'VS Code settings synchronized',
      )
      return this.read()
    })
    this.pending = operation.catch(() => {})
    return operation
  }

  private async write(value: SettingsSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFileAtomic(this.path, value.content, { mode: 0o600 })
    // A synchronized write keeps the original save time, not the copy time.
    await utimes(this.path, new Date(), new Date(value.mtime))
  }

  async settled(): Promise<void> {
    await this.pending
  }
}
