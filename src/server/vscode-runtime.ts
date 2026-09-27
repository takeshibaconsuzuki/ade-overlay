import { execFile } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
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
import { silentLogger } from './logging.ts'
import {
  codeEnvironment,
  findLocalCode,
  stopProcess,
  type LocalCode,
} from './code-cli.ts'

const execute = promisify(execFile)
const commitPattern = /^[a-f0-9]{40}$/
const updateIntervalMs = 60 * 60 * 1000

export interface EditorRuntime {
  executable: string
  entrypoint: string
}

// Isolated from editor sessions: checking for an update never restarts a session.
export class EditorRuntimeManager extends EventEmitter<{ progress: [string] }> {
  private current?: EditorRuntime
  private code?: Promise<LocalCode>
  private checking?: Promise<EditorRuntime>
  private timer?: NodeJS.Timeout
  private stage = 'Checking for VS Code updates'
  private readonly abort = new AbortController()
  private readonly dataDir: string
  private readonly logger: Logger

  constructor(dataDir: string, logger: Logger = silentLogger) {
    super()
    this.dataDir = dataDir
    this.logger = logger
  }

  localCode(): Promise<LocalCode> {
    this.code ??= findLocalCode(this.logger, this.abort.signal)
      .then((code) => {
        if (!code)
          throw new Error(
            'VS Code is required on the companion machine. Install VS Code and add code (or code-insiders) to its PATH.',
          )
        return code
      })
      .catch((error: unknown) => {
        this.code = undefined
        throw error
      })
    return this.code
  }

  startUpdates(): void {
    if (this.timer || this.abort.signal.aborted) return
    const check = () => {
      void this.checkForUpdates().catch((error) =>
        this.logger.warn({ err: error }, 'Could not prepare VS Code'),
      )
    }
    check()
    this.timer = setInterval(check, updateIntervalMs)
    this.timer.unref()
  }

  async get(): Promise<EditorRuntime> {
    this.abort.signal.throwIfAborted()
    await this.localCode()
    if (!this.current) this.emit('progress', this.stage)
    return this.current ?? this.checkForUpdates()
  }

  checkForUpdates(): Promise<EditorRuntime> {
    this.abort.signal.throwIfAborted()
    this.checking ??= this.update().finally(() => {
      this.checking = undefined
    })
    return this.checking
  }

  private progress(message: string): void {
    this.stage = message
    this.logger.info(message)
    this.emit('progress', message)
  }

  private async update(): Promise<EditorRuntime> {
    const code = await this.localCode()
    const record = join(this.dataDir, `runtime-${code.channel}.json`)
    const runtimeRoot = (commit: string) =>
      join(
        this.dataDir,
        'runtimes',
        `${code.channel}-${commit}-${terminalSerializationRevision}`,
      )
    if (!this.current) {
      try {
        const { commit } = JSON.parse(await readFile(record, 'utf8'))
        if (!commitPattern.test(commit))
          throw new Error('Invalid cached runtime version.')
        this.current = await retainRuntime(
          join(this.dataDir, 'runtimes', `${code.channel}-${commit}`),
          runtimeRoot(commit),
          commit,
          this.abort.signal,
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          this.logger.warn(
            { err: error },
            'Could not reuse the saved VS Code runtime',
          )
      }
    }
    this.progress('Checking for VS Code updates')
    try {
      const { root, commit } = await prepareRuntime(
        this.dataDir,
        code,
        this.logger,
        (message) => this.progress(message),
        this.abort.signal,
      )
      const destination = runtimeRoot(commit)
      const runtime = await retainRuntime(
        root,
        destination,
        commit,
        this.abort.signal,
      )
      const temporary = `${record}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ commit }), { mode: 0o600 })
        this.abort.signal.throwIfAborted()
        await rename(temporary, record)
      } finally {
        await rm(temporary, { force: true })
      }
      this.current = runtime
      this.logger.info(
        { commit, channel: code.channel },
        'VS Code runtime ready for new editor sessions',
      )
      return runtime
    } catch (error) {
      this.abort.signal.throwIfAborted()
      if (!this.current) throw error
      this.logger.warn(
        { err: error },
        'VS Code update failed; using the last working runtime',
      )
      this.progress('Using the last working VS Code version')
      return this.current
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer)
    this.abort.abort(new Error('Companion is shutting down.'))
    await this.checking?.catch(() => {})
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
    await validateRuntime(root, commit, signal)
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
      await validateTerminalSerialization(prepared, signal)
      await rename(prepared, destination)
    } finally {
      await removeStaging(parent, staging)
    }
  }
  const runtime = await validateRuntime(destination, commit, signal)
  await validateTerminalSerialization(destination, signal)
  return runtime
}

export async function validateRuntime(
  root: string,
  commit: string,
  signal?: AbortSignal,
): Promise<EditorRuntime> {
  const product = JSON.parse(await readFile(join(root, 'product.json'), 'utf8'))
  if (!commitPattern.test(commit) || product.commit !== commit)
    throw new Error(
      'VS Code runtime version does not match the prepared release.',
    )
  const runtime = {
    executable: join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    entrypoint: join(root, 'out', 'server-main.js'),
  }
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
): Promise<{ root: string; commit: string }> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(dataDir, '.code-bootstrap-'))
  const token = randomBytes(32).toString('hex')
  const tokenFile = join(staging, 'token')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const cliData = join(dataDir, 'cli', code.channel)
  const child = spawn(
    code.command,
    [
      'serve-web',
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
  let commit: string | undefined
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
      // Wait for the update check, not the first cached HTTP 200. serve-web
      // can serve its previous release while its background check is pending.
      const release = /refreshed latest release:.*?\b([a-f0-9]{40})\b/i.exec(
        safe,
      )
      if (release) commit = release[1]
      if (/error getting latest (release|version)/i.test(safe))
        failure = new Error('VS Code could not check for updates.')
    })
  }
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  try {
    while (true) {
      timeout.throwIfAborted()
      if (failure) throw failure
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`VS Code update preparation stopped: ${output.trim()}`)
      if (port && commit) {
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
          progress('Downloading the latest VS Code server')
        }
        if (status === 200) {
          const root = join(cliData, 'serve-web', commit)
          await validateRuntime(root, commit, timeout)
          return { root, commit }
        }
        if (status >= 400)
          throw new Error(`VS Code update preparation failed (HTTP ${status}).`)
      }
      await delay(100, undefined, { signal: timeout })
    }
  } finally {
    await stopProcess(child)
    await removeStaging(dataDir, staging)
  }
}
