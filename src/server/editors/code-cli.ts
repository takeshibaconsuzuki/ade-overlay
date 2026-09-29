import { join } from 'node:path'
import { homedir } from 'node:os'
import { execa } from 'execa'
import which from 'which'
import type { Logger } from 'pino'

export interface LocalCode {
  command: string
  commit: string
  userDataDir: string
  extensionsDir: string
}

// Discover the local profile from the parent's environment, but prevent child
// overrides from taking precedence over each editor's explicit user-data-dir.
// Also remove credentials and parent routing; match names case-insensitively.
export function codeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env))
    if (
      [
        'ADE_COMPANION_TOKEN',
        'ADE_CHAT_EXTENSION_TOKEN',
        'VSCODE_IPC_HOOK_CLI',
        'VSCODE_DEV',
        'VSCODE_PORTABLE',
        'VSCODE_APPDATA',
        'VSCODE_EXTENSIONS',
        'ELECTRON_RUN_AS_NODE',
        // The companion's --watch reporter uses its own IPC channel. Editors
        // close their credential channel before loading the VS Code modules.
        'WATCH_REPORT_DEPENDENCIES',
      ].includes(name.toUpperCase())
    )
      delete env[name]
  return env
}

async function commandOutput(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const { stdout } = await execa(command, args, {
    env: codeEnvironment(),
    extendEnv: false,
    windowsHide: true,
    stdin: 'ignore',
    maxBuffer: 64 * 1024,
    timeout: 10_000,
    cancelSignal: signal,
    killDescendants: true,
  })
  return stdout
}

export async function findLocalCode(
  logger: Logger,
  signal?: AbortSignal,
): Promise<LocalCode> {
  signal?.throwIfAborted()
  const command = await which('code', { nothrow: true })
  if (!command) throw new Error('Install stable VS Code and put code on PATH.')
  const version = await commandOutput(command, ['--version'], signal)
  const commit = version.match(/\b[a-f0-9]{40}\b/)?.[0]
  if (!commit || /insider/i.test(version))
    throw new Error('VS Code CLI must report a stable release commit.')
  const help = await commandOutput(command, ['serve-web', '--help'], signal)
  for (const option of [
    '--cli-data-dir',
    '--connection-token-file',
    '--commit-id',
  ])
    if (!help.includes(option))
      throw new Error(`VS Code CLI does not support ${option}.`)
  const home = homedir()
  const appData =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
  logger.info({ command, commit }, 'Using stable VS Code from PATH')
  return {
    command,
    commit,
    userDataDir: join(appData, 'Code'),
    extensionsDir: join(home, '.vscode', 'extensions'),
  }
}
