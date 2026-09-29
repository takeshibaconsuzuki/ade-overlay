import { z } from 'zod'
import { SettingsSnapshot } from './settings-snapshot.ts'
export { SettingsSnapshot } from './settings-snapshot.ts'

export const MAX_SETTINGS_BYTES = 1024 * 1024

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
