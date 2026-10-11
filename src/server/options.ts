import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from './constants'

const home = homedir()
const configHome =
  process.platform === 'win32'
    ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))

// Paths belong to the server host. Custom installations and profiles can override them.
export const vscodeOptionsSchema = z.strictObject({
  extensionsDirectory: z
    .string()
    .trim()
    .min(1)
    .default(join(home, '.vscode', 'extensions')),
  settingsFile: z
    .string()
    .trim()
    .min(1)
    .default(join(configHome, 'Code', 'User', 'settings.json')),
})

export const projectSchema = z.strictObject({
  mainWorktreePath: z
    .string()
    .min(1)
    .refine((path) => path.trim().length > 0),
})

export type Project = z.infer<typeof projectSchema>

export const serverOptionsSchema = z.strictObject({
  host: z.string().trim().min(1).default(DEFAULT_SERVER_HOST),
  // Port 0 asks the operating system to allocate an available port.
  port: z.int().min(0).max(65535).default(DEFAULT_SERVER_PORT),
  projects: z.array(projectSchema).default([]),
  // Host integration paths are selected at startup; changing them requires a server restart.
  vscode: vscodeOptionsSchema.prefault({}),
})

export type ServerOptions = z.infer<typeof serverOptionsSchema>

export async function optionsFromFile(path: string): Promise<ServerOptions> {
  try {
    const config: unknown = parse(await readFile(path, 'utf8'))
    const options = serverOptionsSchema.parse(config)
    const directory = dirname(resolve(path))
    options.vscode.extensionsDirectory = resolve(
      directory,
      options.vscode.extensionsDirectory,
    )
    options.vscode.settingsFile = resolve(
      directory,
      options.vscode.settingsFile,
    )
    return options
  } catch (error) {
    throw new Error(`Failed to load server configuration from "${path}"`, {
      cause: error,
    })
  }
}
