import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { EDITOR_BASE_PATH } from '../../api/server/editor'
import { SERVER_ORIGIN } from '../../api/server/config'
import { type Logger } from '../../api/server/logger'
import { getEditorDataDir } from '../dataDir'
import { HttpError } from '../errors'
import { getFreePort, waitForPort } from '../ports'
import { type Worktree } from '../worktrees/schemas'
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

  const child = spawnCodeServeWeb(worktree, port, serverDataDir)
  const spawnError = waitForSpawnError(child)
  log.info(
    {
      worktreeId: worktree.worktreeId,
      port,
      serverDataDir,
      path: worktree.path,
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
): ChildProcess {
  return spawn(
    'code',
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
