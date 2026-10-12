import { resolve } from 'node:path'
import type { VscodeServerStatus } from '../shared/api'
import type { VscodeLauncher, VscodeProcess } from './vscode-process'
import type { VscodeInstallation, VscodeRuntime } from './vscode-runtime'
import { vscodeBasePath } from './vscode-route'

export interface VscodeServer {
  readonly snapshot: VscodeServerStatus
  readonly target: string | undefined
  ensure(serverUrl: string): void
  // Cancels startup and waits for termination; a stopped server may be started again.
  // The owner must prevent new starts before stopping a server it intends to discard.
  stop(): Promise<void>
}

// Prepares shared resources; each worktree owns and stops the server it creates.
export interface VscodeServerFactory {
  prepare(extensionsDirectory: string): Promise<void>
  // Reports lifecycle changes and failures to the owner, which retains errors for clients.
  // A stop failure is reported before its promise rejects.
  create(path: string, onChanged: (error?: Error) => void): VscodeServer
  close(): Promise<void>
}

export class ProcessVscodeServerFactory implements VscodeServerFactory {
  private readonly controller = new AbortController()
  private preparing: Promise<void> | undefined
  private installation: VscodeInstallation | undefined
  private extensionsDirectory = ''
  private closing: Promise<void> | undefined

  constructor(
    private readonly runtime: VscodeRuntime,
    private readonly launcher: VscodeLauncher,
  ) {}

  prepare(extensionsDirectory: string): Promise<void> {
    this.controller.signal.throwIfAborted()
    if (!this.preparing) this.extensionsDirectory = resolve(extensionsDirectory)
    this.preparing ??= this.runtime
      .prepare(this.controller.signal)
      .then((installation) => {
        this.installation = installation
      })
    return this.preparing
  }

  create(path: string, onChanged: (error?: Error) => void): VscodeServer {
    this.controller.signal.throwIfAborted()
    if (!this.installation)
      throw new Error('VS Code Server has not been prepared')
    return new ProcessVscodeServer(
      path,
      this.installation,
      this.launcher,
      this.runtime.dataDirectory,
      this.extensionsDirectory,
      onChanged,
    )
  }

  close(): Promise<void> {
    this.controller.abort(new Error('VS Code factory closed'))
    this.closing ??= this.preparing?.catch(() => {}) ?? Promise.resolve()
    return this.closing
  }
}

class ProcessVscodeServer implements VscodeServer {
  private status: VscodeServerStatus
  private controller: AbortController | undefined
  private process: VscodeProcess | undefined
  private task: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private upstream: string | undefined
  private cleanupError: unknown

  constructor(
    private readonly path: string,
    private readonly installation: VscodeInstallation,
    private readonly launcher: VscodeLauncher,
    private readonly dataDirectory: string,
    private readonly extensionsDirectory: string,
    private readonly onChanged: (error?: Error) => void,
  ) {
    this.status = { path, state: 'stopped' }
  }

  get snapshot(): VscodeServerStatus {
    return structuredClone(this.status)
  }
  get target(): string | undefined {
    return this.upstream
  }

  ensure(serverUrl: string): void {
    if (this.stopping || this.status.state === 'stopping')
      throw new Error('VS Code server is stopping')
    if (this.status.state !== 'stopped') return
    this.controller = new AbortController()
    this.status = { path: this.path, state: 'starting' }
    this.task = this.start(this.controller.signal, serverUrl)
    this.onChanged()
  }

  private failed(error: unknown): void {
    this.onChanged(error instanceof Error ? error : new Error(String(error)))
  }

  private async start(signal: AbortSignal, serverUrl: string): Promise<void> {
    try {
      const child = await this.launcher.launch(
        this.installation,
        this.path,
        this.dataDirectory,
        signal,
        this.extensionsDirectory,
        serverUrl,
      )
      this.process = child
      // Observe readiness even when cancellation wins while the launcher is pending.
      void child.ready.catch(() => {})
      signal.throwIfAborted()
      const connection = await child.ready
      signal.throwIfAborted()
      this.upstream = `http://127.0.0.1:${connection.port}`
      this.status.browserPath = `${vscodeBasePath(this.path)}/?tkn=${encodeURIComponent(connection.token)}`
      this.status.state = 'running'
      this.onChanged()
      const exit = await child.exited
      if (!signal.aborted && (exit.code !== 0 || exit.signal))
        throw new Error(
          `VS Code Server exited unexpectedly (${exit.signal ?? exit.code})`,
        )
    } catch (error) {
      if (!signal.aborted) this.failed(error)
    } finally {
      this.upstream = undefined
      delete this.status.browserPath
      try {
        await this.process?.stop()
        this.process = undefined
        this.cleanupError = undefined
        this.status.state = 'stopped'
      } catch (error) {
        this.cleanupError = error
        this.status.state = 'stopping'
        this.failed(error)
      }
      this.onChanged()
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.controller?.abort(new Error('VS Code server stopped'))
    this.upstream = undefined
    delete this.status.browserPath
    if (this.task) this.status.state = 'stopping'
    this.stopping = (async () => {
      if (this.process) {
        await this.process.stop()
        this.process = undefined
        this.cleanupError = undefined
      }
      // A pending launch can still produce a child whose cleanup fails.
      await this.task
      if (this.cleanupError) throw this.cleanupError
      this.status.state = 'stopped'
      this.onChanged()
    })()
      .catch((error: unknown) => {
        this.failed(error)
        throw error
      })
      .finally(() => {
        this.stopping = undefined
      })
    this.onChanged()
    return this.stopping
  }
}
