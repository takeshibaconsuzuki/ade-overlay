import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  CHAT_PROVIDER,
  type ChatCommand,
  type ChatSession,
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
  private chatClientCount = 0
  private lastCommand: ChatCommand | null = null
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
      this.terminals.terminalIdForSession(providerId, chatId),
    )
    this.terminals.events.on('terminal-snapshot', this.onTerminalSnapshot)
    this.worktrees.events.on('worktree-event', this.onWorktreeEvent)
    this.worktrees.events.on('worktree-snapshot', this.onWorktreeSnapshot)
  }

  getLastCommand(): ChatCommand | null {
    return this.lastCommand
  }

  registerChatClient(): () => void {
    this.chatClientCount += 1
    let registered = true
    return () => {
      if (!registered) {
        return
      }
      registered = false
      this.chatClientCount = Math.max(0, this.chatClientCount - 1)
    }
  }

  /** Ensure the chat app is running without changing foreground focus. */
  openChat(): void {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Chat service is shutting down')
    }
    this.lastCommand = null
    this.ensureChatApp()
  }

  focusChat(target?: { providerId: string; chatId: string }): void {
    let command: ChatCommand = { type: 'show' }
    if (target) {
      const terminalId = this.terminals.terminalIdForSession(
        target.providerId,
        target.chatId,
      )
      if (terminalId) {
        command = { type: 'show', ...target, terminalId }
      } else {
        this.log.warn(target, 'chat show target has no terminal')
      }
    }
    this.emitCommand(command)
    this.log.info(
      {
        chatId: 'chatId' in command ? command.chatId : undefined,
        terminalId: 'terminalId' in command ? command.terminalId : undefined,
      },
      'chat show emitted',
    )
  }

  /** Historical, on-disk sessions for a worktree, most-recent first. */
  async listSessions(worktreeId: string): Promise<ChatSession[]> {
    const worktree = await this.worktrees.getWorktreeById(worktreeId)
    return this.registry.listSessions(worktree)
  }

  /** Start a terminal running a new or resumed chat session in the worktree. */
  async createTerminal(options: {
    worktreeId: string
    providerId?: string
    resumeSessionId?: string
    title?: string
  }): Promise<Terminal> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Chat service is shutting down')
    }
    const worktree = await this.worktrees.getWorktreeById(options.worktreeId)
    const providerId = options.providerId ?? CHAT_PROVIDER.claude
    const launch = this.registry.getLaunch(providerId, options.resumeSessionId)
    if (!launch) {
      throw new HttpError(400, `Unknown chat provider: ${providerId}`)
    }
    const sessionId = launch.sessionId ?? options.resumeSessionId
    if (sessionId) {
      const existing = this.terminals
        .list(options.worktreeId)
        .find(
          (terminal) =>
            terminal.providerId === providerId &&
            terminal.sessionId === sessionId,
        )
      if (existing) {
        return existing
      }
    }

    return this.terminals.create({
      worktreeId: options.worktreeId,
      providerId,
      // Prefer the launch's pinned session id (a resumed id, or a fresh one the
      // provider named) so the terminal links to its live chat; fall back to the
      // requested resume id.
      sessionId,
      resumed: !!options.resumeSessionId,
      title: options.title,
      cwd: worktree.path,
      command: launch.command,
      args: launch.args,
    })
  }

  private ensureChatApp(): void {
    if (this.chatClientCount > 0) {
      return
    }
    if (this.chatProcess && isChildAlive(this.chatProcess)) {
      return
    }

    const child = spawn(roleExecutablePath('chat'), roleLaunchArgs('chat'), {
      detached: true,
      env: { ...process.env, ADE_LOG_SOURCE: 'chat' },
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
      }
      this.log.info({ code, signal }, 'chat app exited')
    })
    this.chatProcess = child
    this.log.info({ pid: child.pid }, 'chat app launched')
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
    this.lastCommand = command
    this.commands.emit('command', command)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.worktrees.events.off('worktree-event', this.onWorktreeEvent)
    this.worktrees.events.off('worktree-snapshot', this.onWorktreeSnapshot)
    this.terminals.events.off('terminal-snapshot', this.onTerminalSnapshot)
    this.commands.removeAllListeners()

    const chatProcess = this.chatProcess
    this.chatProcess = null
    if (chatProcess) {
      await killChildProcessTree(chatProcess, this.log, 'chat app')
    }
  }
}
