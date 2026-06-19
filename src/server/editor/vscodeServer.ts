import { type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { execa } from 'execa'
import { SERVER_ORIGIN } from '../../api/server/config'
import { EDITOR_BASE_PATH } from '../../api/server/editor'
import { type Logger } from '../../api/server/logger'
import { type Worktree } from '../../api/server/worktrees'
import { getEditorDataDir } from '../dataDir'
import { HttpError } from '../errors'
import { getFreePort, waitForPort } from '../ports'
import { writeAdeHelperExtension } from './adeHelperExtension'
import { symlinkLocalExtensions } from './userData'

export type VscodeServerSession = {
  port: number
  process: ChildProcess
}

export async function startVscodeServer(
  worktree: Worktree,
  log: Logger,
): Promise<VscodeServerSession> {
  const port = await getFreePort()
  const serverDataDir = getServerDataDir(worktree.worktreeId)
  await mkdir(serverDataDir, { recursive: true })
  const extensionsDir = join(serverDataDir, 'extensions')
  await symlinkLocalExtensions(extensionsDir, log)
  await writeAdeHelperExtension(extensionsDir, log)

  const codeCliPath = await resolveVscodeCliPath()
  const child = spawnCodeServeWeb(worktree, port, serverDataDir, codeCliPath)
  const spawnError = waitForSpawnError(child)
  log.info(
    {
      worktreeId: worktree.worktreeId,
      port,
      serverDataDir,
      path: worktree.path,
      codeCliPath,
    },
    'starting vscode serve-web',
  )

  child.stdout?.on('data', (chunk: Buffer) => {
    log.info(
      {
        worktreeId: worktree.worktreeId,
        output: chunk.toString('utf8').trim(),
      },
      'vscode stdout',
    )
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    log.warn(
      {
        worktreeId: worktree.worktreeId,
        output: chunk.toString('utf8').trim(),
      },
      'vscode stderr',
    )
  })
  child.on('error', (error) => {
    log.error({ err: error, worktreeId: worktree.worktreeId }, 'vscode error')
  })

  await Promise.race([waitForVscodePort(port, child), spawnError])
  log.info({ worktreeId: worktree.worktreeId, port }, 'vscode serve-web ready')

  return { port, process: child }
}

function spawnCodeServeWeb(
  worktree: Worktree,
  port: number,
  serverDataDir: string,
  codeCliPath: string,
): ChildProcess {
  const child = execa(
    codeCliPath,
    [
      'serve-web',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--server-base-path',
      EDITOR_BASE_PATH,
      '--server-data-dir',
      serverDataDir,
      '--default-folder',
      worktree.path,
      '--without-connection-token',
      '--accept-server-license-terms',
      '--disable-telemetry',
    ],
    {
      cwd: worktree.path,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The injected ADE helper extension reads these to open files (e.g.
      // creation logs) pushed from the server over its back-channel.
      env: {
        ...process.env,
        ADE_SERVER_ORIGIN: SERVER_ORIGIN,
        ADE_WORKTREE_ID: worktree.worktreeId,
      },
    },
  )
  child.catch(() => {
    // Startup failures are reported by waitForVscodePort()/waitForSpawnError().
    // Later exits are handled by EditorService's process lifecycle listeners.
  })
  return child
}

async function resolveVscodeCliPath(): Promise<string> {
  const configuredPath = process.env.VSCODE_CLI_PATH
  if (configuredPath) {
    if (await isExecutable(configuredPath)) {
      return configuredPath
    }

    throw new HttpError(
      500,
      `VSCODE_CLI_PATH is not executable: ${configuredPath}`,
    )
  }

  for (const command of getVscodeCliBasenames()) {
    const pathCode = await findExecutableOnPath(command)
    if (pathCode) {
      return pathCode
    }
  }

  for (const candidate of getVscodeCliCandidates()) {
    if (await isExecutable(candidate)) {
      return candidate
    }
  }

  throw new HttpError(
    500,
    'Could not find the VS Code CLI. Install Visual Studio Code or set VSCODE_CLI_PATH to the code executable.',
  )
}

async function findExecutableOnPath(command: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) {
      continue
    }

    const candidate = join(directory, command)
    if (await isExecutable(candidate)) {
      return candidate
    }
  }

  return null
}

function getVscodeCliBasenames(): string[] {
  if (process.platform === 'win32') {
    return ['code.cmd', 'code.exe', 'code.com', 'code.bat']
  }

  return ['code']
}

function getVscodeCliCandidates(): string[] {
  if (process.platform === 'win32') {
    return [
      join(
        homedir(),
        'AppData',
        'Local',
        'Programs',
        'Microsoft VS Code',
        'bin',
        'code.cmd',
      ),
      join(
        homedir(),
        'AppData',
        'Local',
        'Programs',
        'Microsoft VS Code Insiders',
        'bin',
        'code-insiders.cmd',
      ),
      'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
      'C:\\Program Files\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd',
    ]
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
      '/Applications/VSCodium.app/Contents/Resources/app/bin/codium',
      join(
        homedir(),
        'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      ),
      join(
        homedir(),
        'Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
      ),
      join(
        homedir(),
        'Applications/VSCodium.app/Contents/Resources/app/bin/codium',
      ),
    ]
  }

  return []
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function waitForSpawnError(child: ChildProcess): Promise<never> {
  return new Promise((_, reject) => {
    child.once('error', (error) => {
      reject(
        new HttpError(500, `Failed to start VS Code CLI: ${error.message}`),
      )
    })
  })
}

async function waitForVscodePort(
  port: number,
  child: ChildProcess,
): Promise<void> {
  try {
    await waitForPort(port, child)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Process exited')) {
      throw new HttpError(500, 'VS Code server exited before it was ready')
    }
    throw new HttpError(500, `Timed out waiting for VS Code server: ${message}`)
  }
}

function getServerDataDir(worktreeId: string): string {
  return join(getEditorDataDir(), worktreeId, 'server-data')
}
