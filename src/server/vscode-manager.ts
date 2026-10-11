import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { VscodeServerStatus } from '../shared/api'
import { logger } from '../shared/logger'
import type { VscodeLauncher, VscodeProcess } from './vscode-process'
import type { VscodeInstallation, VscodeRuntime } from './vscode-runtime'
import { vscodeBasePath } from './vscode-route'
import type { VscodeProxyTargets } from './vscode-proxy'

const log = logger.child({ component: 'vscode-manager' })

interface Entry {
  status: VscodeServerStatus
  task?: Promise<void>
  process?: VscodeProcess
  target?: string
}

export interface VscodeServerManager extends VscodeProxyTargets {
  readonly snapshot: VscodeServerStatus[]
  setOnChangedListener(
    listener: ((snapshot: VscodeServerStatus[]) => void) | undefined,
  ): void
  prepare(extensionsDirectory: string): Promise<void>
  ensure(path: string): void
  clearError(path: string, errorId: string): void
  close(): Promise<void>
}

export class ProcessVscodeServerManager implements VscodeServerManager {
  private readonly entries = new Map<string, Entry>()
  private readonly controller = new AbortController()
  private onChanged: ((snapshot: VscodeServerStatus[]) => void) | undefined
  private preparing: Promise<void> | undefined
  private installation: VscodeInstallation | undefined
  private closing: Promise<void> | undefined
  private extensionsDirectory = ''

  constructor(
    private readonly runtime: VscodeRuntime,
    private readonly launcher: VscodeLauncher,
  ) {}

  get snapshot(): VscodeServerStatus[] {
    return structuredClone(
      [...this.entries.values()].map((entry) => entry.status),
    )
  }

  getTarget(basePath: string): string | undefined {
    return this.entries.get(basePath)?.target
  }

  setOnChangedListener(
    listener: ((snapshot: VscodeServerStatus[]) => void) | undefined,
  ): void {
    this.onChanged = listener
  }

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

  ensure(path: string): void {
    this.controller.signal.throwIfAborted()
    if (!this.installation)
      throw new Error('VS Code Server has not been prepared')
    if (typeof path !== 'string' || !path.trim())
      throw new Error('Invalid worktree path')
    let entry = this.entries.get(vscodeBasePath(path))
    if (!entry) {
      entry = { status: { path, state: 'stopped' } }
      this.entries.set(vscodeBasePath(path), entry)
    }
    if (entry.status.state !== 'stopped') {
      log.info(
        { path: entry.status.path, state: entry.status.state },
        'VS Code Server launch skipped: already running or starting',
      )
      return
    }
    entry.status = { path: entry.status.path, state: 'starting' }
    log.info({ path: entry.status.path }, 'Starting VS Code Server')
    // Set starting synchronously so concurrent RPCs join the same launch.
    entry.task = this.start(entry, this.installation)
    this.publish()
  }

  clearError(path: string, errorId: string): void {
    this.controller.signal.throwIfAborted()
    const entry = this.entries.get(vscodeBasePath(path))
    // A delayed dismissal must not clear a newer failure.
    if (!entry || entry.status.error?.id !== errorId) return
    delete entry.status.error
    this.publish()
  }

  private async start(
    entry: Entry,
    installation: VscodeInstallation,
  ): Promise<void> {
    const signal = this.controller.signal
    try {
      signal.throwIfAborted()
      const child = await this.launcher.launch(
        installation,
        entry.status.path,
        this.runtime.dataDirectory,
        signal,
        this.extensionsDirectory,
      )
      entry.process = child
      const connection = await child.ready
      signal.throwIfAborted()
      entry.target = `http://127.0.0.1:${connection.port}`
      entry.status.browserPath = `${vscodeBasePath(entry.status.path)}/?tkn=${encodeURIComponent(connection.token)}`
      entry.status.state = 'running'
      log.info({ path: entry.status.path }, 'VS Code Server ready')
      this.publish()
      const exit = await child.exited
      if (!signal.aborted && (exit.code !== 0 || exit.signal)) {
        throw new Error(
          `VS Code Server exited unexpectedly (${exit.signal ?? exit.code})`,
        )
      }
    } catch (error) {
      if (!signal.aborted) {
        entry.status.error = {
          id: randomUUID(),
          message: error instanceof Error ? error.message : String(error),
        }
        log.error(
          { err: error, path: entry.status.path },
          'VS Code Server failed',
        )
      }
    } finally {
      entry.target = undefined
      delete entry.status.browserPath
      // A failed readiness check must not leave a process behind.
      try {
        await entry.process?.stop()
      } catch (error) {
        log.error(
          { err: error, path: entry.status.path },
          'Failed to stop VS Code Server',
        )
        if (!signal.aborted)
          entry.status.error = {
            id: randomUUID(),
            message: error instanceof Error ? error.message : String(error),
          }
      }
      entry.process = undefined
      entry.status.state = 'stopped'
      log.info({ path: entry.status.path }, 'VS Code Server stopped')
      this.publish()
    }
  }

  private publish(): void {
    if (!this.controller.signal.aborted) this.onChanged?.(this.snapshot)
  }

  private async stop(entry: Entry): Promise<void> {
    await entry.process?.stop()
    await entry.task
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.controller.abort(new Error('VS Code manager closed'))
      this.onChanged = undefined
      await Promise.all([
        this.preparing?.catch(() => {}),
        ...[...this.entries.values()].map((entry) => this.stop(entry)),
      ])
    })()
    return this.closing
  }
}
