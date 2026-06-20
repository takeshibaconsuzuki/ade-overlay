import { EventEmitter } from 'node:events'
import { type WebSocket } from 'ws'
import { type Logger } from '../../api/server/logger'
import { type Terminal } from '../../api/server/terminals'
import { TerminalManager } from './manager'

export class TerminalService {
  readonly events = new EventEmitter()

  private readonly manager: TerminalManager

  constructor(log: Logger) {
    this.manager = new TerminalManager(log, () => {
      this.events.emit('terminal-snapshot', this.list())
    })
  }

  terminalIdForSession(
    providerId: string,
    sessionId: string,
  ): string | undefined {
    return this.manager.terminalIdForSession(providerId, sessionId)
  }

  bindSessionToTerminal(
    providerId: string,
    worktreeId: string,
    sessionId: string,
    hookAncestorPids?: number[],
  ): string | undefined {
    return this.manager.bindSessionToTerminal(
      providerId,
      worktreeId,
      sessionId,
      hookAncestorPids,
    )
  }

  create(options: {
    worktreeId: string
    providerId: string
    sessionId?: string
    title?: string
    cwd: string
    command: string
    args: string[]
    preChatCommand?: string
    resumed?: boolean
  }): Terminal {
    return this.manager.create(options)
  }

  list(worktreeId?: string): Terminal[] {
    return this.manager.list(worktreeId)
  }

  attach(terminalId: string, socket: WebSocket, viewerId?: string): void {
    this.manager.attach(terminalId, socket, viewerId)
  }

  closeForWorktree(worktreeId: string): void {
    this.manager.closeForWorktree(worktreeId)
  }

  shutdown(): void {
    this.events.removeAllListeners()
    this.manager.shutdown()
  }
}
