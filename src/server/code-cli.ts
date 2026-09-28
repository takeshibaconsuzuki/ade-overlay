import { realpath, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { ChildProcess } from 'node:child_process'
import spawn from 'cross-spawn'
import which from 'which'
import treeKill from 'tree-kill'
import type { Logger } from 'pino'

export interface LocalCode {
  command: string
  commit: string
  channel: 'stable' | 'insider'
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
        'ELECTRON_RUN_AS_NODE',
        // The companion's --watch reporter uses its own IPC channel. Editors
        // close their credential channel before loading the VS Code modules.
        'WATCH_REPORT_DEPENDENCIES',
      ].includes(name.toUpperCase())
    )
      delete env[name]
  return env
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  let onClose: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    onClose = resolve
    child.once('close', onClose)
  })
  try {
    const error = await new Promise<Error | undefined>((resolve) => {
      treeKill(child.pid!, 'SIGTERM', resolve)
    })
    if (error) {
      // Windows taskkill can report an exiting descendant before Node receives
      // the parent's close event. Only accept that error if closure follows.
      await Promise.race([
        closed,
        delay(1000, undefined, { ref: false }).then(() => {
          throw error
        }),
      ])
    }
    await closed
  } finally {
    child.removeListener('close', onClose)
  }
}

async function commandOutput(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const child = spawn(command, args, {
    env: codeEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let failure: Error | undefined
  child.on('error', (error) => {
    failure = error
  })
  child.stdout!.on('data', (data: Buffer) => {
    output = (output + data.toString()).slice(-64 * 1024)
  })
  child.stderr!.resume()
  try {
    const deadline = Date.now() + 10_000
    while (child.exitCode === null && child.signalCode === null) {
      if (failure) throw failure
      signal?.throwIfAborted()
      if (Date.now() > deadline)
        throw new Error('VS Code CLI discovery timed out.')
      await delay(50, undefined, { signal })
    }
    if (child.exitCode !== 0) throw new Error('VS Code CLI discovery failed.')
    return output
  } finally {
    await stopProcess(child)
  }
}

export async function findLocalCode(
  logger: Logger,
  signal?: AbortSignal,
): Promise<LocalCode | undefined> {
  for (const name of ['code', 'code-insiders']) {
    const command = await which(name, { nothrow: true })
    if (!command) continue
    try {
      const version = await commandOutput(command, ['--version'], signal)
      const commit = version.match(/\b[a-f0-9]{40}\b/)?.[0]
      if (!commit)
        throw new Error('VS Code CLI did not report a server commit.')
      const help = await commandOutput(command, ['serve-web', '--help'], signal)
      if (
        !help.includes('--cli-data-dir') ||
        !help.includes('--connection-token-file')
      )
        throw new Error(
          'VS Code CLI does not support the required serve-web options.',
        )
      const insiders = name === 'code-insiders'
      const home = homedir()
      const executable = await realpath(command)
      const root = dirname(dirname(executable))
      const portable =
        process.env.VSCODE_PORTABLE ??
        (process.platform === 'darwin'
          ? resolve(
              root,
              '../../../..',
              insiders ? 'code-insiders-portable-data' : 'code-portable-data',
            )
          : join(root, 'data'))
      const isPortable = await access(join(portable, 'user-data')).then(
        () => true,
        () => false,
      )
      const appData =
        process.env.VSCODE_APPDATA ??
        (process.platform === 'win32'
          ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
          : process.platform === 'darwin'
            ? join(home, 'Library', 'Application Support')
            : (process.env.XDG_CONFIG_HOME ?? join(home, '.config')))
      const local = {
        command,
        commit,
        channel: insiders ? ('insider' as const) : ('stable' as const),
        userDataDir: isPortable
          ? join(portable, 'user-data')
          : join(appData, insiders ? 'Code - Insiders' : 'Code'),
        extensionsDir:
          process.env.VSCODE_EXTENSIONS ??
          (isPortable
            ? join(portable, 'extensions')
            : join(
                home,
                insiders ? '.vscode-insiders' : '.vscode',
                'extensions',
              )),
      }
      logger.info({ command, commit }, 'Using VS Code from PATH')
      return local
    } catch (error) {
      signal?.throwIfAborted()
      logger.warn({ command, err: error }, 'Could not use VS Code from PATH')
    }
  }
  return undefined
}
