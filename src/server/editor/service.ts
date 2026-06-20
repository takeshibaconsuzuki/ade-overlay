import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { SERVER_PORT } from '../../api/server/config'
import {
  EDITOR_BOOTSTRAP_PATH,
  type EditorCommand,
  type EditorSessionStatus,
  type EditorSessionStatusValue,
} from '../../api/server/editor'
import { type Logger } from '../../api/server/logger'
import {
  type WorktreeEvent,
  type WorktreeSnapshot,
} from '../../api/server/worktrees'
import { HttpError } from '../errors'
import { isChildAlive, killChildProcessTree } from '../processes'
import { roleExecutablePath, roleLaunchArgs } from '../roleLauncher'
import { type WorktreeRegistry } from '../worktrees/registry'
import { renderBootstrapHtml } from './bootstrap'
import { readUserDataPayload } from './userData'
import { startVscodeServer } from './vscodeServer'

type EditorSession = {
  worktreeId: string
  port: number
  process: ChildProcess
  url: string
}

type ReadyWaiter = {
  launchId: string
  promise: Promise<boolean>
  complete: (ready: boolean) => void
}

export class EditorService {
  readonly commands = new EventEmitter()
  readonly sessionStatusEvents = new EventEmitter()

  private readonly sessions = new Map<string, EditorSession>()
  private readonly pendingSessions = new Map<string, Promise<EditorSession>>()
  private readonly sessionStatuses = new Map<string, EditorSessionStatusValue>()
  private readonly lastSwitchTimes = new Map<string, string>()
  private editorProcess: ChildProcess | null = null
  private launchId: string | null = null
  private readyLaunchId: string | null = null
  private readyWaiter: ReadyWaiter | null = null
  private editorClientCount = 0
  // Last file requested per worktree, replayed when the helper extension
  // (re)connects so a cold session start never misses the open.
  private readonly lastOpenFile = new Map<string, string>()
  private readonly pendingCommandAcks = new Map<string, () => void>()
  private shuttingDown = false

  private readonly onWorktreeEvent = (event: WorktreeEvent): void => {
    void this.handleWorktreeEvent(event).catch((error: unknown) => {
      this.log.error({ err: error, event }, 'editor lifecycle cleanup failed')
    })
  }

  private readonly onWorktreeSnapshot = (snapshot: WorktreeSnapshot): void => {
    void this.closeUntrackedWorktrees(snapshot).catch((error: unknown) => {
      this.log.error({ err: error }, 'editor snapshot lifecycle cleanup failed')
    })
  }

  constructor(
    private readonly registry: WorktreeRegistry,
    private readonly log: Logger,
    // Invoked when a worktree's editor session starts, so agentic coding
    // systems are wired up even for worktrees created before this existed (or
    // added as pre-existing repositories that never ran creation).
    private readonly configureWorktree?: (worktree: {
      worktreeId: string
      path: string
    }) => Promise<void>,
  ) {
    this.registry.events.on('worktree-event', this.onWorktreeEvent)
    this.registry.events.on('worktree-snapshot', this.onWorktreeSnapshot)
  }

  registerEditorClient(): () => void {
    this.editorClientCount += 1
    let registered = true
    return () => {
      if (!registered) {
        return
      }
      registered = false
      this.editorClientCount = Math.max(0, this.editorClientCount - 1)
    }
  }

  /** Open a worktree in the editor. */
  async openWorktree(worktreeId: string): Promise<{
    worktreeId: string
    url: string
    alreadyStarted: boolean
  }> {
    return this.switchEditorTo(worktreeId)
  }

  private async switchEditorTo(
    worktreeId: string,
  ): Promise<{ worktreeId: string; url: string; alreadyStarted: boolean }> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Editor service is shutting down')
    }
    const alreadyStarted = this.hasLiveSession(worktreeId)
    this.recordSwitch(worktreeId)
    const session = await this.ensureSession(worktreeId)
    await this.ensureEditorAppReady()

    const command: EditorCommand = {
      type: 'switch',
      worktreeId,
      url: session.url,
    }
    this.emitCommand(command)
    this.log.info({ worktreeId, url: session.url }, 'editor switch emitted')
    this.showEditor()

    return { worktreeId, url: session.url, alreadyStarted }
  }

  showEditor(): void {
    this.emitCommand({ type: 'show' })
    this.log.info('editor show emitted')
  }

  focusEditor(): void {
    this.emitCommand({ type: 'focus' })
    this.log.info('editor focus emitted')
  }

  async openFile(worktreeId: string, filePath: string): Promise<void> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Editor service is shutting down')
    }
    this.lastOpenFile.set(worktreeId, filePath)
    const session = await this.ensureSession(worktreeId)
    await this.ensureEditorAppReady()
    this.emitCommand({
      type: 'open-file',
      worktreeId,
      url: session.url,
      filePath,
    })
    this.log.info({ worktreeId, filePath }, 'editor open-file emitted')
  }

  getLastOpenFile(worktreeId: string): string | undefined {
    return this.lastOpenFile.get(worktreeId)
  }

  getSessionStatuses(): EditorSessionStatus[] {
    return [...this.sessionStatuses.entries()]
      .filter(([, status]) => status !== 'off')
      .map(([worktreeId, status]) => this.toSessionStatus(worktreeId, status))
  }

  private setSessionStatus(
    worktreeId: string,
    status: EditorSessionStatusValue,
  ): void {
    if (this.sessionStatuses.get(worktreeId) === status) {
      return
    }
    if (status === 'off') {
      this.sessionStatuses.delete(worktreeId)
      this.lastSwitchTimes.delete(worktreeId)
    } else {
      this.sessionStatuses.set(worktreeId, status)
    }
    this.emitSessionStatus(worktreeId, status)
  }

  private recordSwitch(worktreeId: string): void {
    this.lastSwitchTimes.set(worktreeId, new Date().toISOString())
    const status = this.sessionStatuses.get(worktreeId)
    if (status) {
      this.emitSessionStatus(worktreeId, status)
    }
  }

  private emitSessionStatus(
    worktreeId: string,
    status: EditorSessionStatusValue,
  ): void {
    this.sessionStatusEvents.emit(
      'session-status',
      this.toSessionStatus(worktreeId, status),
    )
  }

  private toSessionStatus(
    worktreeId: string,
    status: EditorSessionStatusValue,
  ): EditorSessionStatus {
    return {
      worktreeId,
      status,
      lastSwitchAt: this.lastSwitchTimes.get(worktreeId),
    }
  }

  async getProxyPort(worktreeId: string): Promise<number> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Editor service is shutting down')
    }
    return (await this.ensureSession(worktreeId)).port
  }

  async getBootstrapHtml(worktreeId: string): Promise<string> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Editor service is shutting down')
    }
    await this.registry.getWorktreeById(worktreeId)
    return renderBootstrapHtml(await readUserDataPayload())
  }

  ackEditorCommand(commandId: string): void {
    const resolve = this.pendingCommandAcks.get(commandId)
    if (!resolve) {
      return
    }
    this.pendingCommandAcks.delete(commandId)
    resolve()
  }

  private async ensureSession(worktreeId: string): Promise<EditorSession> {
    const existing = this.sessions.get(worktreeId)
    if (existing && isChildAlive(existing.process)) {
      return existing
    }
    this.sessions.delete(worktreeId)

    const pending = this.pendingSessions.get(worktreeId)
    if (pending) {
      return pending
    }

    const promise = this.startSession(worktreeId).finally(() => {
      this.pendingSessions.delete(worktreeId)
    })
    this.pendingSessions.set(worktreeId, promise)
    return promise
  }

  private hasLiveSession(worktreeId: string): boolean {
    const existing = this.sessions.get(worktreeId)
    return !!existing && isChildAlive(existing.process)
  }

  private async startSession(worktreeId: string): Promise<EditorSession> {
    this.setSessionStatus(worktreeId, 'starting')
    let worktree
    let vscode
    try {
      worktree = await this.registry.getWorktreeById(worktreeId)
      await this.configureWorktreeChat(worktree)
      vscode = await startVscodeServer(worktree, this.log)
    } catch (error) {
      this.setSessionStatus(worktreeId, 'off')
      throw error
    }
    const child = vscode.process
    const session: EditorSession = {
      worktreeId,
      port: vscode.port,
      process: child,
      url: editorUrlFor(worktreeId),
    }

    child.on('exit', (code, signal) => {
      if (this.sessions.get(worktreeId)?.process === child) {
        this.sessions.delete(worktreeId)
        this.setSessionStatus(worktreeId, 'off')
      }
      this.log.info({ worktreeId, code, signal }, 'vscode serve-web exited')
    })

    this.sessions.set(worktreeId, session)
    if (this.shuttingDown) {
      await killChildProcessTree(child, this.log, 'vscode serve-web')
      this.setSessionStatus(worktreeId, 'off')
      throw new HttpError(503, 'Editor service is shutting down')
    }

    this.setSessionStatus(worktreeId, 'on')
    return session
  }

  private async configureWorktreeChat(worktree: {
    worktreeId: string
    path: string
  }): Promise<void> {
    if (!this.configureWorktree) {
      return
    }
    try {
      await this.configureWorktree(worktree)
    } catch (error) {
      // Non-fatal: a chat-integration failure must not block opening the editor.
      this.log.warn(
        { worktreeId: worktree.worktreeId, err: error },
        'failed to configure worktree chat integration',
      )
    }
  }

  private ensureEditorApp(): string {
    if (this.editorProcess && isChildAlive(this.editorProcess)) {
      if (!this.launchId) {
        this.launchId = randomUUID()
      }
      return this.launchId
    }

    const launchId = randomUUID()
    if (this.launchId) {
      this.resolveReadyWaiter(this.launchId, false)
    }
    this.launchId = launchId
    this.readyLaunchId = null
    const child = spawn(
      roleExecutablePath('editor'),
      roleLaunchArgs('editor'),
      {
        detached: true,
        // ADE_LOG_SOURCE makes the editor process ship its logs to POST /logs
        // (see src/server/logger), so all Electron logging stays centralized in
        // the server's stream rather than its own discarded stdout.
        env: {
          ...process.env,
          ADE_EDITOR_LAUNCH_ID: launchId,
          ADE_LOG_SOURCE: 'editor',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child.unref()
    child.stdout?.on('data', (chunk: Buffer) => {
      this.log.info({ output: chunk.toString('utf8').trim() }, 'editor stdout')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.log.warn({ output: chunk.toString('utf8').trim() }, 'editor stderr')
    })
    child.on('error', (error) => {
      this.log.error({ err: error }, 'editor app launch failed')
    })
    child.on('exit', (code, signal) => {
      if (this.editorProcess === child) {
        this.editorProcess = null
        if (this.launchId === launchId) {
          this.launchId = null
          this.readyLaunchId = null
        }
        this.resolveReadyWaiter(launchId, false)
      }
      this.log.info({ code, signal }, 'editor app exited')
    })
    this.editorProcess = child
    this.log.info({ launchId, pid: child.pid }, 'editor app launched')
    return launchId
  }

  private async ensureEditorAppReady(): Promise<void> {
    const launchId = this.ensureEditorApp()
    if (this.readyLaunchId === launchId) {
      return
    }

    const ready = await this.waitForEditorReady(launchId)
    if (!ready) {
      this.log.warn({ launchId }, 'editor app readiness timed out')
    }
  }

  markReady(launchId: string): boolean {
    if (launchId !== this.launchId) {
      this.log.warn(
        { launchId, currentLaunchId: this.launchId },
        'ignoring stale editor readiness',
      )
      return false
    }
    this.readyLaunchId = launchId
    this.resolveReadyWaiter(launchId, true)
    this.log.info({ launchId }, 'editor app ready')
    return true
  }

  private waitForEditorReady(launchId: string): Promise<boolean> {
    if (this.readyLaunchId === launchId) {
      return Promise.resolve(true)
    }
    if (this.readyWaiter?.launchId === launchId) {
      return this.readyWaiter.promise
    }
    if (this.readyWaiter) {
      this.resolveReadyWaiter(this.readyWaiter.launchId, false)
    }

    let complete: (ready: boolean) => void = () => undefined
    const timeout = setTimeout(() => {
      if (this.readyWaiter?.launchId === launchId) {
        this.readyWaiter = null
      }
      complete(false)
    }, 5_000)
    const promise = new Promise<boolean>((resolve) => {
      complete = (ready) => {
        clearTimeout(timeout)
        resolve(ready)
      }
    })

    this.readyWaiter = { launchId, promise, complete }
    return promise
  }

  private resolveReadyWaiter(launchId: string, ready: boolean): void {
    if (this.readyWaiter?.launchId !== launchId) {
      return
    }
    const waiter = this.readyWaiter
    this.readyWaiter = null
    waiter.complete(ready)
  }

  private async handleWorktreeEvent(event: WorktreeEvent): Promise<void> {
    if (event.type === 'worktree-deleted') {
      await this.closeWorktree(event.worktreeId)
      return
    }

    if (event.type === 'repository-removed') {
      await this.closeUntrackedWorktrees(event.snapshot)
    }
  }

  private async closeUntrackedWorktrees(
    snapshot: WorktreeSnapshot,
  ): Promise<void> {
    const liveWorktreeIds = new Set(
      snapshot.worktrees.map((worktree) => worktree.worktreeId),
    )
    const trackedWorktreeIds = new Set([
      ...this.sessions.keys(),
      ...this.pendingSessions.keys(),
    ])
    await Promise.all(
      [...trackedWorktreeIds]
        .filter((worktreeId) => !liveWorktreeIds.has(worktreeId))
        .map((worktreeId) => this.closeWorktree(worktreeId)),
    )
  }

  async closeWorktree(worktreeId: string): Promise<void> {
    await this.closeWorktreeView(worktreeId)
    await this.stopWorktreeSession(worktreeId)
    this.log.info({ worktreeId }, 'editor worktree closed')
  }

  private async closeWorktreeView(worktreeId: string): Promise<void> {
    const commandId = randomUUID()
    const ackPromise =
      this.editorClientCount > 0
        ? this.waitForEditorCommandAck(commandId, worktreeId)
        : Promise.resolve()
    this.emitCommand({ type: 'close', commandId, worktreeId })
    await ackPromise
  }

  private async stopWorktreeSession(worktreeId: string): Promise<void> {
    const pending = this.pendingSessions.get(worktreeId)
    if (pending) {
      void pending
        .then((session) =>
          killChildProcessTree(
            session.process,
            this.log,
            `vscode serve-web ${worktreeId}`,
          ),
        )
        .catch(() => undefined)
    }

    const existing = this.sessions.get(worktreeId)
    this.sessions.delete(worktreeId)
    this.setSessionStatus(worktreeId, 'off')
    if (existing) {
      await killChildProcessTree(
        existing.process,
        this.log,
        `vscode serve-web ${worktreeId}`,
      )
    }
  }

  private emitCommand(command: EditorCommand): void {
    this.commands.emit('command', command)
  }

  private waitForEditorCommandAck(
    commandId: string,
    worktreeId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommandAcks.delete(commandId)
        reject(
          new HttpError(500, `Timed out closing editor view: ${worktreeId}`),
        )
      }, 5000)

      this.pendingCommandAcks.set(commandId, () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.registry.events.off('worktree-event', this.onWorktreeEvent)
    this.registry.events.off('worktree-snapshot', this.onWorktreeSnapshot)
    this.commands.removeAllListeners()
    this.sessionStatusEvents.removeAllListeners()
    if (this.readyWaiter) {
      this.resolveReadyWaiter(this.readyWaiter.launchId, false)
    }
    for (const resolve of this.pendingCommandAcks.values()) {
      resolve()
    }
    this.pendingCommandAcks.clear()

    const children = [
      ...[...this.sessions.values()].map((session) => ({
        child: session.process,
        label: `vscode serve-web ${session.worktreeId}`,
      })),
      ...(this.editorProcess
        ? [{ child: this.editorProcess, label: 'editor app' }]
        : []),
    ]

    this.sessions.clear()
    this.pendingSessions.clear()
    this.editorProcess = null

    await Promise.all(
      children.map(({ child, label }) =>
        killChildProcessTree(child, this.log, label),
      ),
    )
  }
}

function editorUrlFor(worktreeId: string): string {
  return `http://${worktreeId}.localhost:${SERVER_PORT}${EDITOR_BOOTSTRAP_PATH}`
}
