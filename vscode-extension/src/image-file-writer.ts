import { createHash } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import envPaths from 'env-paths'
import { APP_NAME } from '../../src/shared/constants'

export interface ImageFileWriter {
  // Writes PNG bytes on the terminal host and returns their file path.
  write(data: Uint8Array): Promise<string>
}

// Files live until their terminal closes, including across extension host restarts.
export class TemporaryImageFileWriter implements ImageFileWriter {
  private readonly directory: string
  private operations = Promise.resolve()
  private closed = false

  constructor(terminalId: string) {
    this.directory = join(
      envPaths(APP_NAME).cache,
      'chat-paste',
      createHash('sha256').update(terminalId).digest('hex'),
    )
  }

  async write(data: Uint8Array): Promise<string> {
    const path = join(
      this.directory,
      `${createHash('sha256').update(data).digest('hex')}.png`,
    )
    const operation = this.operations.then(async () => {
      if (this.closed) throw new Error('Chat terminal closed during paste')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await chmod(this.directory, 0o700)
      await writeFile(path, data, { mode: 0o600 })
    })
    this.operations = operation.catch(() => {})
    await operation
    return path
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.operations
    await rm(this.directory, { recursive: true, force: true })
  }
}
