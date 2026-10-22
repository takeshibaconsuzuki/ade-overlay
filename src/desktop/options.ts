import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { DEFAULT_SERVER_URL } from '../shared/constants'

export const desktopOptionsSchema = z.strictObject({
  startCommand: z.string().trim().min(1).optional(),
  serverUrl: z
    .url({ protocol: /^wss?$/ })
    .refine(
      (value) => !URL.parse(value)?.hash,
      'Server URL must not have a fragment',
    )
    .default(DEFAULT_SERVER_URL),
})

export type DesktopOptions = z.infer<typeof desktopOptionsSchema>

// Configuration is read once at startup; the environment overrides the file.
export async function loadDesktopOptions(
  path = join(homedir(), '.ade-overlay', 'desktop.config.yaml'),
): Promise<DesktopOptions> {
  let options: DesktopOptions
  try {
    options = desktopOptionsSchema.parse(parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(`Failed to load desktop configuration from "${path}"`, {
        cause: error,
      })
    options = desktopOptionsSchema.parse({})
  }
  const serverUrl = process.env.ADE_SERVER_URL
  if (serverUrl === undefined) return options
  try {
    return desktopOptionsSchema.parse({ ...options, serverUrl })
  } catch (error) {
    throw new Error('Invalid ADE_SERVER_URL', { cause: error })
  }
}
