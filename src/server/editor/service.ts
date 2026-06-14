import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  EDITOR_BOOTSTRAP_PATH,
  type EditorCommand,
  type EditorSessionStatus,
  type EditorSessionStatusValue,
  type EditorSwitchCommand,
} from '../../api/server/editor'
import { SERVER_PORT } from '../../api/server/config'
import { type Logger } from '../../api/server/logger'
import { HttpError } from '../errors'
import { isChildAlive, killChildProcessTree } from '../processes'
import { type WorktreeRegistry } from '../worktrees/registry'
import { type WorktreeEvent } from '../worktrees/schemas'
import { renderBootstrapHtml } from './bootstrap'
import { readUserDataPayload } from './userData'
import { startVscodeServer } from './vscodeServer'

type EditorSession = {
  worktreeId: string
  port: number
  process: ChildProcess
  url: string
}

export class EditorService {
  readonly commands = new EventEmitter()
  readonly sessionStatusEvents = new EventEmitter()

  private readonly sessions = new Map<string, EditorSession>()
  private readonly pendingSessions = new Map<string, Promise<EditorSession>>()
  private readonly sessionStatuses = new Map<string, EditorSessionStatusValue>()
  private editorProcess: ChildProcess | null = null
  private editorClientCount = 0
  private lastCommand: EditorCommand | null = null
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

  constructor(
    private readonly registry: WorktreeRegistry,
    private readonly log: Logger,
  ) {
    this.registry.events.on('worktree-event', this.onWorktreeEvent)
  }

  getLastCommand(): EditorCommand | null {
    return this.lastCommand
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

  async openCode(worktreeId: string): Promise<{
    worktreeId: string
    url: string
    alreadyStarted: boolean
  }> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Editor service is shutting down')
    }
    const alreadyStarted = this.hasLiveSession(worktreeId)
    const session = await this.ensureSession(worktreeId)
    this.ensureEditorApp()

    const command: EditorSwitchCommand = {
      type: 'switch',
      worktreeId,
      url: session.url,
    }
    this.emitCommand(command)
    this.log.info({ worktreeId, url: session.url }, 'editor switch emitted')

    return { worktreeId, url: session.url, alreadyStarted }
  }

  async openFile(worktreeId: string, filePath: string): Promise<void> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Editor service is shutting down')
    }
    this.lastOpenFile.set(worktreeId, filePath)
    const session = await this.ensureSession(worktreeId)
    this.ensureEditorApp()
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
      .map(([worktreeId, status]) => ({ worktreeId, status }))
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
    } else {
      this.sessionStatuses.set(worktreeId, status)
    }
    const event: EditorSessionStatus = { worktreeId, status }
    this.sessionStatusEvents.emit('session-status', event)
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

  private ensureEditorApp(): void {
    if (this.editorClientCount > 0) {
      return
    }
    if (this.editorProcess && isChildAlive(this.editorProcess)) {
      return
    }

    const child = spawn(process.execPath, getEditorLaunchArgs(), {
      detached: true,
      // ADE_LOG_SOURCE makes the editor process ship its logs to POST /logs
      // (see src/server/logger), so all Electron logging stays centralized in
      // the server's stream rather than its own discarded stdout.
      env: { ...process.env, ADE_LOG_SOURCE: 'editor' },
      stdio: 'ignore',
    })
    child.unref()
    child.on('error', (error) => {
      this.log.error({ err: error }, 'editor app launch failed')
    })
    child.on('exit', () => {
      if (this.editorProcess === child) {
        this.editorProcess = null
      }
    })
    this.editorProcess = child
    this.log.info({ pid: child.pid }, 'editor app launched')
  }

  private async handleWorktreeEvent(event: WorktreeEvent): Promise<void> {
    if (event.type === 'worktree-deleted') {
      await this.closeWorktree(event.worktreeId)
      return
    }

    if (event.type === 'repository-removed') {
      const liveWorktreeIds = new Set(
        event.snapshot.worktrees.map((worktree) => worktree.worktreeId),
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
    this.lastCommand = command
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
    this.commands.removeAllListeners()
    this.sessionStatusEvents.removeAllListeners()
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

function getEditorLaunchArgs(): string[] {
  const args = process.argv.slice(1)
  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--role') {
      index += 1
      continue
    }
    if (arg.startsWith('--role=')) {
      continue
    }
    filtered.push(arg)
  }
  filtered.push('--role', 'editor')
  return filtered
}
