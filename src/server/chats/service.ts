import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  DEFAULT_CHAT_PROVIDER,
  type Chat,
  type ChatCommand,
} from '../../api/server/chats'
import { type Logger } from '../../api/server/logger'
import { type Terminal } from '../../api/server/terminals'
import {
  type WorktreeEvent,
  type WorktreeSnapshot,
} from '../../api/server/worktrees'
import { HttpError } from '../errors'
import { isChildAlive, killChildProcessTree } from '../processes'
import { roleExecutablePath, roleLaunchArgs } from '../roleLauncher'
import { type TerminalService } from '../terminals/service'
import { type WorktreeRegistry } from '../worktrees/registry'
import { type ChatRegistry } from './registry'

type ReadyWaiter = {
  launchId: string
  promise: Promise<boolean>
  complete: (ready: boolean) => void
}

/**
 * Coordinates the chat Electron role (a separate app, like the editor) and the
 * server-hosted terminals it displays. Mirrors {@link EditorService} for app
 * lifecycle: it spawns the chat process on demand and drives it over an SSE
 * command stream. Chat CLIs run in server-owned terminals, but terminal
 * lifecycle is delegated to {@link TerminalService}.
 */
export class ChatService {
  readonly commands = new EventEmitter()

  private chatProcess: ChildProcess | null = null
  private launchId: string | null = null
  private readyLaunchId: string | null = null
  private readyWaiter: ReadyWaiter | null = null
  private shuttingDown = false

  private readonly onWorktreeEvent = (event: WorktreeEvent): void => {
    this.handleWorktreeEvent(event)
  }

  private readonly onWorktreeSnapshot = (snapshot: WorktreeSnapshot): void => {
    this.closeUntrackedTerminals(snapshot)
  }

  private readonly onTerminalSnapshot = (): void => {
    this.registry.notifyTerminalsChanged()
  }

  constructor(
    private readonly registry: ChatRegistry,
    private readonly worktrees: WorktreeRegistry,
    private readonly terminals: TerminalService,
    private readonly log: Logger,
  ) {
    this.registry.setTerminalResolver((providerId, chatId) =>
      this.terminals.terminalIdForChat(providerId, chatId),
    )
    this.registry.setTerminalSessionBinder(
      (providerId, worktreeId, chatId, hookAncestorPids) =>
        this.terminals.bindChatToTerminal(
          providerId,
          worktreeId,
          chatId,
          hookAncestorPids,
        ),
    )
    this.terminals.events.on('terminal-snapshot', this.onTerminalSnapshot)
    this.worktrees.events.on('worktree-event', this.onWorktreeEvent)
    this.worktrees.events.on('worktree-snapshot', this.onWorktreeSnapshot)
  }

  /**
   * Ensure the chat app is running and has installed its command handler,
   * without changing foreground focus.
   */
  async openChat(): Promise<void> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Chat service is shutting down')
    }
    const launchId = this.ensureChatAppProcess()
    if (this.readyLaunchId === launchId) {
      this.showChat()
      return
    }

    const ready = await this.waitForChatReady(launchId)
    if (!ready) {
      this.log.warn({ launchId }, 'chat app readiness timed out')
    }
    this.showChat()
  }

  markReady(launchId: string): boolean {
    if (launchId !== this.launchId) {
      this.log.warn(
        { launchId, currentLaunchId: this.launchId },
        'ignoring stale chat readiness',
      )
      return false
    }
    this.readyLaunchId = launchId
    this.resolveReadyWaiter(launchId, true)
    this.log.info({ launchId }, 'chat app ready')
    return true
  }

  focusChat(target?: { providerId: string; chatId: string }): void {
    let command: ChatCommand = { type: 'focus' }
    if (target) {
      const terminalId = this.terminals.terminalIdForChat(
        target.providerId,
        target.chatId,
      )
      if (terminalId) {
        command = { type: 'focus', ...target, terminalId }
      } else {
        this.log.warn(target, 'chat focus target has no terminal')
      }
    }
    this.emitCommand(command)
    this.log.info(
      {
        chatId: 'chatId' in command ? command.chatId : undefined,
        terminalId: 'terminalId' in command ? command.terminalId : undefined,
      },
      'chat focus emitted',
    )
  }

  private showChat(): void {
    this.emitCommand({ type: 'show' })
    this.log.info('chat show emitted')
  }

  /** Historical, on-disk chats for a worktree, most-recent first. */
  async listHistory(worktreeId: string): Promise<Chat[]> {
    const worktree = await this.worktrees.getWorktreeById(worktreeId)
    return this.registry.listHistory(worktree)
  }

  /** Start a terminal running a new or resumed chat in the worktree. */
  async createTerminal(options: {
    worktreeId: string
    providerId?: string
    resumeChatId?: string
    title?: string
  }): Promise<Terminal> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Chat service is shutting down')
    }
    const worktree = await this.worktrees.getWorktreeById(options.worktreeId)
    const providerId = options.providerId ?? DEFAULT_CHAT_PROVIDER
    const launch = this.registry.getLaunch(providerId, options.resumeChatId)
    if (!launch) {
      throw new HttpError(400, `Unknown chat provider: ${providerId}`)
    }
    const chatId = launch.chatId ?? options.resumeChatId
    if (chatId) {
      const existing = this.terminals
        .list(options.worktreeId)
        .find(
          (terminal) =>
            terminal.providerId === providerId && terminal.chatId === chatId,
        )
      if (existing) {
        return existing
      }
    }

    const preChatCommand = await this.worktrees.getPreChatCommandForWorktree(
      options.worktreeId,
    )
    return this.terminals.create({
      worktreeId: options.worktreeId,
      providerId,
      // Prefer the launch's pinned chat id (a resumed id, or a fresh one the
      // provider named) so the terminal links to its live chat; fall back to the
      // requested resume id.
      chatId,
      resumed: !!options.resumeChatId,
      title: options.title,
      cwd: worktree.path,
      command: launch.command,
      args: launch.args,
      preChatCommand,
    })
  }

  private ensureChatAppProcess(): string {
    if (this.chatProcess && isChildAlive(this.chatProcess)) {
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
    const child = spawn(roleExecutablePath('chat'), roleLaunchArgs('chat'), {
      detached: true,
      env: {
        ...process.env,
        ADE_CHAT_LAUNCH_ID: launchId,
        ADE_LOG_SOURCE: 'chat',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.unref()
    child.stdout?.on('data', (chunk: Buffer) => {
      this.log.info({ output: chunk.toString('utf8').trim() }, 'chat stdout')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.log.warn({ output: chunk.toString('utf8').trim() }, 'chat stderr')
    })
    child.on('error', (error) => {
      this.log.error({ err: error }, 'chat app launch failed')
    })
    child.on('exit', (code, signal) => {
      if (this.chatProcess === child) {
        this.chatProcess = null
        if (this.launchId === launchId) {
          this.launchId = null
          this.readyLaunchId = null
        }
        this.resolveReadyWaiter(launchId, false)
      }
      this.log.info({ code, signal }, 'chat app exited')
    })
    this.chatProcess = child
    this.log.info({ launchId, pid: child.pid }, 'chat app launched')
    return launchId
  }

  private waitForChatReady(launchId: string): Promise<boolean> {
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

  private handleWorktreeEvent(event: WorktreeEvent): void {
    if (event.type === 'worktree-deleted') {
      this.terminals.closeForWorktree(event.worktreeId)
      return
    }
    if (event.type === 'repository-removed') {
      this.closeUntrackedTerminals(event.snapshot)
    }
  }

  private closeUntrackedTerminals(snapshot: WorktreeSnapshot): void {
    const liveWorktreeIds = new Set(
      snapshot.worktrees.map((worktree) => worktree.worktreeId),
    )
    for (const terminal of this.terminals.list()) {
      if (!liveWorktreeIds.has(terminal.worktreeId)) {
        this.terminals.closeForWorktree(terminal.worktreeId)
      }
    }
  }

  private emitCommand(command: ChatCommand): void {
    this.commands.emit('command', command)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.worktrees.events.off('worktree-event', this.onWorktreeEvent)
    this.worktrees.events.off('worktree-snapshot', this.onWorktreeSnapshot)
    this.terminals.events.off('terminal-snapshot', this.onTerminalSnapshot)
    this.commands.removeAllListeners()
    if (this.readyWaiter) {
      this.resolveReadyWaiter(this.readyWaiter.launchId, false)
    }

    const chatProcess = this.chatProcess
    this.chatProcess = null
    if (chatProcess) {
      await killChildProcessTree(chatProcess, this.log, 'chat app')
    }
  }
}
