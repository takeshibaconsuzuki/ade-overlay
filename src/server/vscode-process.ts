import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import pRetry from 'p-retry'
import treeKill from 'tree-kill'
import { logger } from '../shared/logger'
import type { VscodeInstallation } from './vscode-runtime'
import { vscodeBasePath } from './vscode-route'
import { prepareVscodeRemoteSettings } from './vscode-remote-settings'

const log = logger.child({ component: 'vscode-process' })
type Exit = { code: number | null; signal: NodeJS.Signals | null }

export interface VscodeConnection {
  port: number
  token: string
}

export interface VscodeProcess {
  readonly ready: Promise<VscodeConnection>
  readonly exited: Promise<Exit>
  // Concurrent calls share one termination attempt. After success, further calls
  // resolve without repeating termination. After failure, a later call retries.
  stop(): Promise<void>
}

export interface VscodeLauncher {
  launch(
    installation: VscodeInstallation,
    path: string,
    dataDirectory: string,
    signal: AbortSignal,
    extensionsDirectory: string,
    serverUrl: string,
  ): Promise<VscodeProcess>
}

export class NodeVscodeLauncher implements VscodeLauncher {
  launch(
    installation: VscodeInstallation,
    path: string,
    dataDirectory: string,
    signal: AbortSignal,
    extensionsDirectory: string,
    serverUrl: string,
  ): Promise<VscodeProcess> {
    return NodeVscodeProcess.start(
      installation,
      path,
      dataDirectory,
      signal,
      extensionsDirectory,
      serverUrl,
    )
  }
}

export class NodeVscodeProcess implements VscodeProcess {
  readonly ready: Promise<VscodeConnection>
  readonly exited: Promise<Exit>
  private readonly child: ChildProcessByStdio<null, Readable, Readable>
  private resolvePort!: (port: number) => void
  private rejectPort!: (error: unknown) => void
  private readonly port = new Promise<number>((resolve, reject) => {
    this.resolvePort = resolve
    this.rejectPort = reject
  })
  private closed = false
  private spawnError: Error | undefined
  private stderr = ''
  private stopping: Promise<void> | undefined

  static async start(
    installation: VscodeInstallation,
    path: string,
    dataDirectory: string,
    signal: AbortSignal,
    extensionsDirectory: string,
    serverUrl: string,
  ): Promise<NodeVscodeProcess> {
    const cwd = await realpath(path)
    const directory = join(
      dataDirectory,
      createHash('sha256').update(cwd).digest('hex'),
    )
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await prepareVscodeRemoteSettings(directory)
    const token = randomBytes(32).toString('hex')
    const tokenFile = join(directory, 'connection-token')
    await writeFile(tokenFile, token, { mode: 0o600 })
    signal.throwIfAborted()
    return new NodeVscodeProcess(
      installation,
      cwd,
      directory,
      tokenFile,
      token,
      signal,
      vscodeBasePath(path),
      extensionsDirectory,
      serverUrl,
    )
  }

  private constructor(
    installation: VscodeInstallation,
    private readonly path: string,
    directory: string,
    tokenFile: string,
    private readonly token: string,
    private readonly signal: AbortSignal,
    basePath: string,
    extensionsDirectory: string,
    serverUrl: string,
  ) {
    this.child = spawn(
      installation.node,
      [
        installation.entrypoint,
        '--accept-server-license-terms',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--connection-token-file',
        tokenFile,
        '--server-data-dir',
        directory,
        '--extensions-dir',
        extensionsDirectory,
        '--default-folder',
        path,
        '--server-base-path',
        basePath,
      ],
      {
        cwd: path,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ADE_SERVER_URL: serverUrl },
      },
    )
    this.exited = this.observeProcess()
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted) this.abort()
    this.ready = this.waitUntilReady()
  }

  private observeProcess(): Promise<Exit> {
    const stdoutLines = createInterface({ input: this.child.stdout })
    const stderrLines = createInterface({ input: this.child.stderr })
    stdoutLines.on('line', (line: string) => this.onStdout(line))
    stderrLines.on('line', (line: string) => this.onStderr(line))
    this.child.once('error', (error) => {
      this.spawnError = error
      this.rejectPort(error)
    })
    return new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.closed = true
        stdoutLines.close()
        stderrLines.close()
        this.signal.removeEventListener('abort', this.abort)
        this.rejectPort(
          this.spawnError ??
            new Error(
              `VS Code Server exited before becoming ready (${signal ?? code})${this.stderr ? `: ${this.stderr.trim()}` : ''}`,
            ),
        )
        resolve({ code, signal })
      })
    })
  }

  private onStdout(line: string): void {
    const match = /^Extension host agent listening on (\d+)$/.exec(line.trim())
    if (match) this.resolvePort(Number(match[1]))
    log.debug(
      { path: this.path, output: line.replaceAll(this.token, '<redacted>') },
      'VS Code Server output',
    )
  }

  private onStderr(line: string): void {
    const redacted = line.replaceAll(this.token, '<redacted>')
    this.stderr = `${this.stderr}\n${redacted}`.slice(-4096)
    log.debug({ path: this.path, output: redacted }, 'VS Code Server stderr')
  }

  private async waitForPort(signal: AbortSignal): Promise<number> {
    let rejectCancelled!: (error: unknown) => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject
    })
    const onAbort = () => rejectCancelled(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      return await Promise.race([this.port, cancelled])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async probe(port: number, signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('VS Code Server exited during startup')
    const response = await fetch(
      `http://127.0.0.1:${port}/version?tkn=${this.token}`,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      },
    )
    await response.body?.cancel()
    if (!response.ok)
      throw new Error(
        `VS Code Server readiness check failed: HTTP ${response.status}`,
      )
  }

  private async waitUntilReady(): Promise<VscodeConnection> {
    const readinessSignal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(60_000),
    ])
    try {
      const port = await this.waitForPort(readinessSignal)
      await pRetry(() => this.probe(port, readinessSignal), {
        retries: 120,
        minTimeout: 100,
        maxTimeout: 500,
        signal: readinessSignal,
        shouldRetry: () => !this.closed,
      })
      if (this.closed) throw new Error('VS Code Server exited during startup')
      return { port, token: this.token }
    } catch (error) {
      await this.stop()
      if (readinessSignal.aborted && !this.signal.aborted)
        throw new Error(
          'VS Code Server did not become ready within 60 seconds',
          { cause: error },
        )
      throw error
    }
  }

  private readonly abort = (): void => {
    void this.stop().catch((error: unknown) =>
      log.error(
        { err: error, path: this.path },
        'Failed to stop VS Code Server',
      ),
    )
  }

  private async terminate(): Promise<void> {
    const pid = this.child.pid
    if (!this.closed && pid) {
      await new Promise<void>((resolve, reject) => {
        treeKill(pid, 'SIGKILL', (error) => {
          if (error && !this.closed) reject(error)
          else resolve()
        })
      })
    }
    await this.exited
  }

  stop(): Promise<void> {
    this.stopping ??= this.terminate().catch((error: unknown) => {
      this.stopping = undefined
      throw error
    })
    return this.stopping
  }
}
