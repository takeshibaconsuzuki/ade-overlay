import { accessSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

const disabledExtensionsSchema = z.array(
  z.object({ id: z.string().min(1), uuid: z.string().optional() }),
)

// Read a fresh snapshot without creating or changing the host profile database.
// A missing database or key means no disabled extensions; unreadable or invalid storage is an error.
export function readDisabledExtensions(path: string) {
  try {
    try {
      accessSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const row = database
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('extensionsIdentifiers/disabled')
      if (!row) return []
      if (typeof row.value !== 'string')
        throw new Error('Invalid extension enablement value')
      return disabledExtensionsSchema.parse(JSON.parse(row.value))
    } finally {
      database.close()
    }
  } catch (error) {
    throw new Error(`Unable to read host extension enablement from "${path}"`, {
      cause: error,
    })
  }
}
