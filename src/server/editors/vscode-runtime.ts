import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import spawn from 'cross-spawn'
import type { Logger } from 'pino'
import {
  prepareTerminalSerialization,
  terminalSerializationRevision,
  validateTerminalSerialization,
} from './terminal-serialization.ts'
import { silentLogger } from '../logging.ts'
import { vscodeRelease } from './vscode-release.ts'
import { codeEnvironment, findLocalCode, type LocalCode } from './code-cli.ts'
import { stopProcess } from '../../shared/node/process-lifecycle.ts'

const execute = promisify(execFile)
const commitPattern = /^[a-f0-9]{40}$/

export interface EditorRuntime {
  executable: string
  entrypoint: string
}

export interface EditorRuntimeProvider {
  localCode(): Promise<LocalCode>
  get(): Promise<EditorRuntime>
  prepareRuntime(): void
  on(event: 'progress', listener: (message: string) => void): unknown
  close(): Promise<void>
}

// Runtime preparation is shared by sessions and independent of profile discovery.
export class EditorRuntimeManager
  extends EventEmitter<{ progress: [string] }>
  implements EditorRuntimeProvider
{
  private current?: EditorRuntime
  private code?: Promise<LocalCode>
  private preparing?: Promise<EditorRuntime>
  private stage = 'Preparing the approved VS Code runtime'
  private readonly abort = new AbortController()

  private readonly dataDir: string
  private readonly logger: Logger

  constructor(dataDir: string, logger: Logger = silentLogger) {
    super()
    this.dataDir = dataDir
    this.logger = logger
  }

  localCode(): Promise<LocalCode> {
    this.code ??= findLocalCode(this.logger, this.abort.signal).catch(
      (error: unknown) => {
        this.code = undefined
        throw error
      },
    )
    return this.code
  }

  prepareRuntime(): void {
    if (this.abort.signal.aborted) return
    void this.get().catch((error: unknown) =>
      this.logger.warn({ err: error }, 'Could not prepare VS Code'),
    )
  }

  async get(): Promise<EditorRuntime> {
    this.abort.signal.throwIfAborted()
    if (this.current) return this.current
    this.emit('progress', this.stage)
    this.preparing ??= this.prepare().finally(() => {
      this.preparing = undefined
    })
    return this.preparing
  }

  private progress(message: string): void {
    this.stage = message
    this.logger.info(message)
    this.emit('progress', message)
  }

  private async prepare(): Promise<EditorRuntime> {
    const destination = join(
      this.dataDir,
      'runtimes',
      `stable-${vscodeRelease.commit}-${terminalSerializationRevision}`,
    )
    try {
      await access(destination)
      const runtime = await validateRuntime(
        destination,
        vscodeRelease.commit,
        this.abort.signal,
      )
      await validateTerminalSerialization(destination, this.abort.signal)
      this.current = runtime
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const root = await prepareRuntime(
        this.dataDir,
        await this.localCode(),
        this.logger,
        (message) => this.progress(message),
        this.abort.signal,
      )
      this.current = await retainRuntime(
        root,
        destination,
        vscodeRelease.commit,
        this.abort.signal,
      )
    }
    this.logger.info(
      { commit: vscodeRelease.commit },
      'Approved VS Code runtime ready for editor sessions',
    )
    return this.current
  }

  async close(): Promise<void> {
    this.abort.abort(new Error('Companion is shutting down.'))
    await this.preparing?.catch(() => {})
  }
}

// Keep compatibility revisions in separate immutable copies. Existing servers
// may still lazily load files from the previous copy, even for the same commit.
async function retainRuntime(
  root: string,
  destination: string,
  commit: string,
  signal: AbortSignal,
): Promise<EditorRuntime> {
  try {
    await access(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = join(destination, '..')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(parent, '.prepare-'))
    try {
      const prepared = join(staging, 'runtime')
      await cp(root, prepared, {
        recursive: true,
        verbatimSymlinks: true,
        filter: () => {
          signal.throwIfAborted()
          return true
        },
      })
      await prepareTerminalSerialization(prepared)
      await validateRuntime(prepared, commit, signal)
      await validateTerminalSerialization(prepared, signal)
      signal.throwIfAborted()
      await rename(prepared, destination)
      return runtimePaths(destination)
    } finally {
      await removeStaging(parent, staging)
    }
  }
  const runtime = await validateRuntime(destination, commit, signal)
  await validateTerminalSerialization(destination, signal)
  return runtime
}

function runtimePaths(root: string): EditorRuntime {
  return {
    executable: join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    entrypoint: join(root, 'out', 'server-main.js'),
  }
}

async function validateRuntime(
  root: string,
  commit: string,
  signal?: AbortSignal,
): Promise<EditorRuntime> {
  const product = JSON.parse(await readFile(join(root, 'product.json'), 'utf8'))
  if (!commitPattern.test(commit) || product.commit !== commit)
    throw new Error(
      'VS Code runtime version does not match the prepared release.',
    )
  const runtime = runtimePaths(root)
  const { stdout } = await execute(
    runtime.executable,
    [runtime.entrypoint, '--help'],
    {
      env: codeEnvironment(),
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      signal,
    },
  )
  for (const option of [
    '--reconnection-grace-time',
    '--extensions-dir',
    '--user-data-dir',
    '--server-data-dir',
    '--connection-token-file',
    '--server-base-path',
  ]) {
    if (!stdout.includes(option))
      throw new Error(`The prepared VS Code server does not support ${option}.`)
  }
  return runtime
}

async function removeStaging(parent: string, path: string): Promise<void> {
  if (!resolve(path).startsWith(resolve(parent) + sep))
    throw new Error('Invalid staging directory.')
  await rm(path, { recursive: true, force: true, maxRetries: 5 })
}

async function prepareRuntime(
  dataDir: string,
  code: LocalCode,
  logger: Logger,
  progress: (message: string) => void,
  signal: AbortSignal,
): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(dataDir, '.code-bootstrap-'))
  const token = randomBytes(32).toString('hex')
  const tokenFile = join(staging, 'token')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const cliData = join(dataDir, 'cli', 'stable')
  const child = spawn(
    code.command,
    [
      'serve-web',
      '--commit-id',
      vscodeRelease.commit,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--cli-data-dir',
      cliData,
      '--server-data-dir',
      join(staging, 'data'),
      '--connection-token-file',
      tokenFile,
      '--accept-server-license-terms',
      '--disable-telemetry',
      '--log',
      'debug',
    ],
    {
      windowsHide: true,
      env: codeEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let port: number | undefined
  let output = ''
  let failure: Error | undefined
  let downloading = false
  child.on('error', (error) => {
    failure = error
  })
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', (line) => {
      const safe = line.replaceAll(token, '[redacted]')
      logger.debug({ output: safe }, 'VS Code CLI output')
      output = (output + safe + '\n').slice(-8192)
      const listening = /Web UI available at http:\/\/127\.0\.0\.1:(\d+)/.exec(
        safe,
      )
      if (listening) port = Number(listening[1])
    })
  }
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  try {
    while (true) {
      timeout.throwIfAborted()
      if (failure) throw failure
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`VS Code runtime preparation stopped: ${output.trim()}`)
      if (port) {
        const status = await fetch(`http://127.0.0.1:${port}/`, {
          headers: { Cookie: `vscode-tkn=${token}` },
          signal: AbortSignal.any([timeout, AbortSignal.timeout(2000)]),
        })
          .then(async (response) => {
            await response.arrayBuffer()
            return response.status
          })
          .catch(() => 0)
        if (status === 202 && !downloading) {
          downloading = true
          progress('Downloading the approved VS Code server')
        }
        if (status === 200) {
          return join(cliData, 'serve-web', vscodeRelease.commit)
        }
        if (status >= 400)
          throw new Error(
            `VS Code runtime preparation failed (HTTP ${status}).`,
          )
      }
      await delay(100, undefined, { signal: timeout })
    }
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    await stopProcess(child)
    await removeStaging(dataDir, staging)
  }
}
