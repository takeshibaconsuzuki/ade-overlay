import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { type WebSocket } from 'ws'
import { CHAT_PROVIDER, type ChatCommand } from '../../api/server/chats'
import { type Logger } from '../../api/server/logger'
import { HttpError } from '../errors'
import { isChildAlive, killChildProcessTree } from '../processes'
import { type WorktreeRegistry } from '../worktrees/registry'
import { type WorktreeEvent } from '../worktrees/schemas'
import { type ChatRegistry } from './registry'
import { type ChatSession, type ChatTerminal } from './schemas'
import { TerminalManager } from './terminals'

/**
 * Coordinates the chat Electron role (a separate app, like the editor) and the
 * server-hosted terminals it displays. Mirrors {@link EditorService} for app
 * lifecycle: it spawns the chat process on demand and drives it over an SSE
 * command stream, while the terminals themselves live in {@link TerminalManager}
 * so they outlive the window.
 */
export class ChatService {
  readonly commands = new EventEmitter()

  private readonly terminals: TerminalManager
  private chatProcess: ChildProcess | null = null
  private chatClientCount = 0
  private lastCommand: ChatCommand | null = null
  private shuttingDown = false

  private readonly onWorktreeEvent = (event: WorktreeEvent): void => {
    this.handleWorktreeEvent(event)
  }

  constructor(
    private readonly registry: ChatRegistry,
    private readonly worktrees: WorktreeRegistry,
    private readonly log: Logger,
  ) {
    // Re-broadcast chats whenever the terminal set changes so each chat's
    // server-stamped `terminalId` (and thus "openable" everywhere) stays current.
    this.terminals = new TerminalManager(log, () =>
      this.registry.notifyTerminalsChanged(),
    )
    this.registry.setTerminalResolver((providerId, chatId) =>
      this.terminals.terminalIdForSession(providerId, chatId),
    )
    this.worktrees.events.on('worktree-event', this.onWorktreeEvent)
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

  focusChat(target?: { providerId?: string; chatId?: string }): void {
    const command: ChatCommand =
      target?.chatId && target.providerId
        ? { type: 'show', providerId: target.providerId, chatId: target.chatId }
        : { type: 'show' }
    this.emitCommand(command)
    this.log.info({ chatId: command.chatId }, 'chat show emitted')
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
  }): Promise<ChatTerminal> {
    if (this.shuttingDown) {
      throw new HttpError(503, 'Chat service is shutting down')
    }
    const worktree = await this.worktrees.getWorktreeById(options.worktreeId)
    const providerId = options.providerId ?? CHAT_PROVIDER.claude
    const launch = this.registry.getLaunch(providerId, options.resumeSessionId)
    if (!launch) {
      throw new HttpError(400, `Unknown chat provider: ${providerId}`)
    }

    return this.terminals.create({
      worktreeId: options.worktreeId,
      providerId,
      // Prefer the launch's pinned session id (a resumed id, or a fresh one the
      // provider named) so the terminal links to its live chat; fall back to the
      // requested resume id.
      sessionId: launch.sessionId ?? options.resumeSessionId,
      resumed: !!options.resumeSessionId,
      title: options.title,
      cwd: worktree.path,
      command: launch.command,
      args: launch.args,
    })
  }

  listTerminals(worktreeId?: string): ChatTerminal[] {
    return this.terminals.list(worktreeId)
  }

  attachTerminal(terminalId: string, socket: WebSocket, viewerId?: string): void {
    this.terminals.attach(terminalId, socket, viewerId)
  }

  private ensureChatApp(): void {
    if (this.chatClientCount > 0) {
      return
    }
    if (this.chatProcess && isChildAlive(this.chatProcess)) {
      return
    }

    const child = spawn(process.execPath, chatLaunchArgs(), {
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
      const liveWorktreeIds = new Set(
        event.snapshot.worktrees.map((worktree) => worktree.worktreeId),
      )
      for (const terminal of this.terminals.list()) {
        if (!liveWorktreeIds.has(terminal.worktreeId)) {
          this.terminals.closeForWorktree(terminal.worktreeId)
        }
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
    this.commands.removeAllListeners()
    this.terminals.shutdown()

    const chatProcess = this.chatProcess
    this.chatProcess = null
    if (chatProcess) {
      await killChildProcessTree(chatProcess, this.log, 'chat app')
    }
  }
}

/**
 * Re-derive this process's launch args with the role forced to `chat`, so the
 * spawned Electron process boots the chat window. Mirrors the editor's
 * `getEditorLaunchArgs`.
 */
function chatLaunchArgs(): string[] {
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
  filtered.push('--role', 'chat')
  return filtered
}
