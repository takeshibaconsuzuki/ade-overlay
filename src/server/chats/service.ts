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
import { type TerminalChange, type TerminalService } from '../terminals/service'
import { type WorktreeRegistry } from '../worktrees/registry'
import { type ChatRegistry } from './registry'

type ReadyWaiter = {
  launchId: string
  promise: Promise<boolean>
  complete: (ready: boolean) => void
}

type ChatTerminalBinding = {
  providerId: string
  worktreeId: string
  chatId?: string
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
  private readonly terminalBindings = new Map<string, ChatTerminalBinding>()
  private readonly chatTerminals = new Map<string, string>()

  private readonly onWorktreeEvent = (event: WorktreeEvent): void => {
    this.handleWorktreeEvent(event)
  }

  private readonly onWorktreeSnapshot = (snapshot: WorktreeSnapshot): void => {
    this.closeUntrackedTerminals(snapshot)
  }

  private readonly onTerminalSnapshot = (): void => {
    this.registry.notifyTerminalsChanged()
  }

  private readonly onTerminalChange = (event: TerminalChange): void => {
    this.handleTerminalChange(event)
  }

  constructor(
    private readonly registry: ChatRegistry,
    private readonly worktrees: WorktreeRegistry,
    private readonly terminals: TerminalService,
    private readonly log: Logger,
  ) {
    this.registry.setTerminalResolver((providerId, chatId) =>
      this.terminalIdForChat(providerId, chatId),
    )
    this.registry.setTerminalSessionBinder(
      (providerId, worktreeId, chatId, hookAncestorPids, hookCwd) =>
        this.bindChatToTerminal(
          providerId,
          worktreeId,
          chatId,
          hookAncestorPids,
          hookCwd,
        ),
    )
    this.terminals.events.on('terminal-snapshot', this.onTerminalSnapshot)
    this.terminals.events.on('terminal-change', this.onTerminalChange)
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
      const terminalId = this.terminalIdForChat(
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

  private handleTerminalChange(event: TerminalChange): void {
    if (event.type !== 'removed') {
      return
    }

    const binding = this.terminalBindings.get(event.terminal.terminalId)
    this.terminalBindings.delete(event.terminal.terminalId)
    if (!binding?.chatId) {
      return
    }

    this.chatTerminals.delete(chatKey(binding.providerId, binding.chatId))
    this.registry.markDormant(binding.providerId, binding.chatId)
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
      const existingTerminalId = this.terminalIdForChat(providerId, chatId)
      const existing = existingTerminalId
        ? this.terminals
            .list(options.worktreeId)
            .find((terminal) => terminal.terminalId === existingTerminalId)
        : undefined
      if (existing?.worktreeId === options.worktreeId) {
        return existing
      }
    }

    const preChatCommand = await this.worktrees.getPreChatCommandForWorktree(
      options.worktreeId,
    )
    const terminal = this.terminals.create({
      worktreeId: options.worktreeId,
      resumed: !!options.resumeChatId,
      title: terminalTitle(providerId, chatId, options.title),
      cwd: worktree.path,
      command: launch.command,
      args: launch.args,
      preChatCommand,
    })
    this.terminalBindings.set(terminal.terminalId, {
      providerId,
      worktreeId: options.worktreeId,
      chatId,
    })
    if (chatId) {
      this.chatTerminals.set(chatKey(providerId, chatId), terminal.terminalId)
    }
    return terminal
  }

  private terminalIdForChat(
    providerId: string,
    chatId: string,
  ): string | undefined {
    const terminalId = this.chatTerminals.get(chatKey(providerId, chatId))
    if (!terminalId) {
      return undefined
    }
    const terminal = this.terminals
      .list()
      .find((entry) => entry.terminalId === terminalId)
    if (!terminal) {
      this.chatTerminals.delete(chatKey(providerId, chatId))
      return undefined
    }
    return terminalId
  }

  private async bindChatToTerminal(
    providerId: string,
    worktreeId: string | undefined,
    chatId: string,
    hookAncestorPids?: number[],
    hookCwd?: string,
  ): Promise<string | undefined> {
    const existing = this.terminalIdForChat(providerId, chatId)
    if (existing) {
      return this.terminals
        .list()
        .find((terminal) => terminal.terminalId === existing)?.worktreeId
    }

    const owned = this.terminals.terminalForHookProcess(hookAncestorPids)
    if (
      owned &&
      this.canBindTerminal(owned.terminalId, providerId, owned.worktreeId)
    ) {
      this.recordChatBinding(
        owned.terminalId,
        providerId,
        owned.worktreeId,
        chatId,
      )
      this.log.info(
        {
          terminalId: owned.terminalId,
          providerId,
          worktreeId: owned.worktreeId,
          chatId,
          hookAncestorPids,
        },
        'chat terminal bound to chat by process ancestry',
      )
      this.registry.notifyTerminalsChanged()
      return owned.worktreeId
    }

    if (hookCwd) {
      const worktree = await this.worktrees.findWorktreeByPath(hookCwd)
      worktreeId = worktree?.worktreeId ?? worktreeId
    }

    if (!worktreeId) {
      return undefined
    }

    const candidates = this.terminals
      .list(worktreeId)
      .filter((terminal) =>
        this.canBindTerminal(terminal.terminalId, providerId, worktreeId),
      )
    if (candidates.length !== 1) {
      return worktreeId
    }

    const [terminal] = candidates
    this.recordChatBinding(terminal.terminalId, providerId, worktreeId, chatId)
    this.log.info(
      { terminalId: terminal.terminalId, providerId, worktreeId, chatId },
      'chat terminal bound to chat',
    )
    this.registry.notifyTerminalsChanged()
    return terminal.worktreeId
  }

  private canBindTerminal(
    terminalId: string,
    providerId: string,
    worktreeId: string,
  ): boolean {
    const binding = this.terminalBindings.get(terminalId)
    return (
      binding !== undefined &&
      binding.providerId === providerId &&
      binding.worktreeId === worktreeId &&
      binding.chatId === undefined
    )
  }

  private recordChatBinding(
    terminalId: string,
    providerId: string,
    worktreeId: string,
    chatId: string,
  ): void {
    this.terminalBindings.set(terminalId, { providerId, worktreeId, chatId })
    this.chatTerminals.set(chatKey(providerId, chatId), terminalId)
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
    this.terminals.events.off('terminal-change', this.onTerminalChange)
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

function chatKey(providerId: string, chatId: string): string {
  return `${providerId}:${chatId}`
}

function terminalTitle(
  providerId: string,
  chatId: string | undefined,
  title: string | undefined,
): string {
  if (title) {
    return title
  }
  return chatId
    ? `${providerId} · ${chatId.slice(0, 8)}`
    : `New ${providerId} chat`
}
