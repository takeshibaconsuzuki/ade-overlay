import { z } from 'zod'

export const MAX_SETTINGS_BYTES = 1024 * 1024

// The unit of storage, transport and comparison. Keep this class dependency-free:
// the companion also serves it to the editor's browser settings bridge.
export class SettingsSnapshot {
  readonly content: string
  readonly mtime: number

  constructor(content: string, mtime: number) {
    this.content = content
    this.mtime = mtime
    Object.freeze(this)
  }

  static from(
    value: Pick<SettingsSnapshot, 'content' | 'mtime'>,
  ): SettingsSnapshot {
    return new this(value.content, value.mtime)
  }

  equals(other: SettingsSnapshot): boolean {
    return this.content === other.content && this.mtime === other.mtime
  }
}

export const settingsSnapshotSchema = z
  .object({
    content: z
      .string()
      .max(MAX_SETTINGS_BYTES)
      .refine(
        (content) =>
          new TextEncoder().encode(content).byteLength <= MAX_SETTINGS_BYTES,
        'VS Code settings exceed 1 MiB.',
      ),
    mtime: z.number().finite().min(0).max(8_640_000_000_000_000),
  })
  .transform((value) => SettingsSnapshot.from(value))
