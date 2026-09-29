import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parse } from 'yaml'
import { z } from 'zod'
import { chatCommandsSchema } from '../shared/chat-commands.ts'

export const serverConfigSchema = z.object({
  editor: z
    .object({
      dataDir: z
        .string()
        .regex(/\S/)
        .refine((value) => !value.includes('\0'))
        .optional(),
      // Node timers overflow above 2^31-1 milliseconds; zero expires immediately.
      reconnectionGraceSeconds: z
        .number()
        .int()
        .min(1)
        .max(2_147_483)
        .optional(),
      localUserDataDir: z
        .string()
        .regex(/\S/)
        .refine((value) => !value.includes('\0'))
        .optional(),
      localExtensionsDir: z
        .string()
        .regex(/\S/)
        .refine((value) => !value.includes('\0'))
        .optional(),
    })
    .strict()
    .optional(),
  projects: z.array(
    z
      .object({
        mainWorktreePath: z
          .string()
          .regex(/\S/, 'Project paths must not be blank.')
          .refine(
            (path) => !path.includes('\0'),
            'Project paths must not contain a null byte.',
          ),
        chatCommands: chatCommandsSchema.optional(),
        bootstrapCommand: z
          .string()
          .refine((value) => !value.includes('\0'))
          .optional(),
      })
      .strict(),
  ),
})

export type ServerConfig = z.infer<typeof serverConfigSchema>

export function expandHome(path: string): string {
  return path === '~'
    ? homedir()
    : /^~[/\\]/.test(path)
      ? resolve(homedir(), path.slice(2))
      : path
}

export function parseServerArgs(args: string[]): {
  configPath?: string
  help?: boolean
  version?: boolean
  setup?: boolean
} {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      setup: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  if (values.config !== undefined && !values.config.trim())
    throw new Error('--config requires a file path.')
  return {
    configPath: values.config,
    ...(values.help ? { help: true } : {}),
    ...(values.version ? { version: true } : {}),
    ...(values.setup ? { setup: true } : {}),
  }
}

export async function loadServerConfig(
  configPath?: string,
): Promise<ServerConfig> {
  const path = resolve(expandHome(configPath ?? '~/.ade-overlay/server.yaml'))
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (
      configPath === undefined &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return { projects: [] }
    throw new Error(
      `Could not read config ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  let config: ServerConfig
  try {
    config = serverConfigSchema.parse(parse(source))
  } catch (error) {
    throw new Error(
      `Invalid config ${path}: ${error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const normalized: ServerConfig = {
    projects: config.projects.map((project) => ({
      ...project,
      mainWorktreePath: resolve(
        dirname(path),
        expandHome(project.mainWorktreePath),
      ),
    })),
  }
  if (config.editor) {
    normalized.editor = { ...config.editor }
    for (const key of [
      'dataDir',
      'localUserDataDir',
      'localExtensionsDir',
    ] as const) {
      const value = config.editor[key]
      if (value !== undefined)
        normalized.editor[key] = resolve(dirname(path), expandHome(value))
    }
  }
  return normalized
}
