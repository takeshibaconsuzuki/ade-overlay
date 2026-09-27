import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { normalizeCompanionUrl } from '../shared/companion.ts'

const desktopConfigSchema = z
  .object({
    url: z.string().optional(),
    token: z
      .string()
      .max(4096)
      .regex(/^[\x21-\x7e]*$/)
      .optional(),
  })
  .strict()

// A shortcut or Finder launch does not inherit an interactive shell's variables.
// Keep the token in main, just like the environment-based configuration.
export function loadDesktopConfig(
  path = join(homedir(), '.ade-overlay', 'client.json'),
  env: NodeJS.ProcessEnv = process.env,
): { url?: string; token?: string } {
  let input: unknown = {}
  try {
    input = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        `Could not read ${path}. Expected a JSON object with url and optional token.`,
        { cause: error },
      )
  }
  const parsed = desktopConfigSchema.safeParse(input)
  if (!parsed.success)
    throw new Error(
      `Invalid desktop configuration in ${path}. Expected url and optional token strings.`,
    )
  const configuration = desktopConfigSchema.parse({
    url: env.ADE_COMPANION_URL ?? parsed.data.url,
    token: env.ADE_COMPANION_TOKEN ?? parsed.data.token,
  })
  return {
    ...configuration,
    url:
      configuration.url === undefined
        ? undefined
        : normalizeCompanionUrl(configuration.url),
  }
}
