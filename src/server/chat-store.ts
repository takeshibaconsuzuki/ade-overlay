import { chatSchema, type Chat } from '../shared/api'
import { logger } from '../shared/logger'
import { UnknownChatProviderError, type ChatProvider } from './chat-provider'
import type { ProcessProbe } from './process-probe'
import { MAX_CHAT_DESCRIPTION_LENGTH } from './constants'

const log = logger.child({ component: 'chat-store' })
// This is a live registry; a restarted server is repopulated by subsequent hooks.
export class ChatStore {
  private readonly chats = new Map<string, Chat>()
  private pending = Promise.resolve()
  private readonly timer: NodeJS.Timeout
  private closed = false
  private onChanged: ((snapshot: Record<string, Chat>) => void) | undefined
  private onTurnFinished: ((chat: Chat) => void) | undefined

  constructor(
    private readonly processes: ProcessProbe,
    private readonly providers: ChatProvider[],
    purgeIntervalMs = 30_000,
  ) {
    this.timer = setInterval(() => {
      try {
        this.purge()
      } catch (error) {
        log.warn({ err: error }, 'Failed to purge dead chats')
      }
    }, purgeIntervalMs)
    this.timer.unref()
  }

  get snapshot(): Record<string, Chat> {
    return Object.fromEntries(
      [...this.chats].map(([id, chat]) => [id, { ...chat }]),
    )
  }

  setOnChangedListener(
    listener: ((snapshot: Record<string, Chat>) => void) | undefined,
  ): void {
    this.onChanged = listener
  }

  setOnTurnFinishedListener(
    listener: ((chat: Chat) => void) | undefined,
  ): void {
    this.onTurnFinished = listener
  }

  async report(providerId: string, value: unknown): Promise<void> {
    if (this.closed) throw new Error('Chat store closed')
    const provider = this.providers.find(
      (provider) => provider.id === providerId,
    )
    if (!provider) throw new UnknownChatProviderError(providerId)
    // Read concurrently, but merge in receipt order so omitted fields inherit preceding updates.
    const pending = Promise.allSettled([
      this.pending,
      provider.readReport(value),
    ]).then(([, result]) => {
      if (this.closed) throw new Error('Chat store closed')
      if (result.status === 'rejected') throw result.reason
      const report = result.value
      const { shouldPurge, chat: incoming } = report
      const id = `${incoming.providerId}:${incoming.sessionId}`
      const previous = this.chats.get(id)
      if (shouldPurge) {
        log.info(
          {
            providerId: incoming.providerId,
            sessionId: incoming.sessionId,
            ownerPid: incoming.pid,
          },
          'Chat session ended',
        )
        if (previous?.pid === incoming.pid) {
          this.chats.delete(id)
          this.onChanged?.(this.snapshot)
        }
        return
      }
      const update = report.transformChat
        ? report.transformChat(previous)
        : incoming
      if (update === undefined) return
      const chat = chatSchema.parse({
        ...previous,
        ...Object.fromEntries(
          Object.entries(update).filter(([, value]) => value !== undefined),
        ),
      })
      // Store description previews so every consumer sees the same bounded text.
      // Titles are expected to be short and intentionally remain untruncated.
      if (chat.description !== undefined)
        chat.description = Array.from(chat.description)
          .slice(0, MAX_CHAT_DESCRIPTION_LENGTH)
          .join('')
      // Terminal ownership follows the reporting process, including external resumes.
      chat.terminalId = update.terminalId
      this.chats.set(id, chat)
      log.info(
        {
          providerId: chat.providerId,
          sessionId: chat.sessionId,
          ownerPid: chat.pid,
          worktreePath: chat.worktreePath,
          status: chat.status,
          previousStatus: previous?.status,
        },
        previous ? 'Chat updated' : 'Chat registered',
      )
      this.onChanged?.(this.snapshot)
      if (previous?.status === 'working' && chat.status === 'idle')
        this.onTurnFinished?.({ ...chat })
    })
    // A failed report rejects its caller without blocking later reports.
    this.pending = pending.catch(() => {})
    await pending
  }

  purge(): void {
    if (this.closed) return
    const alive = new Map<number, boolean>()
    let changed = false
    for (const [id, chat] of this.chats) {
      if (!alive.has(chat.pid))
        alive.set(chat.pid, this.processes.isAlive(chat.pid))
      if (!alive.get(chat.pid)) {
        this.chats.delete(id)
        log.info(
          {
            providerId: chat.providerId,
            sessionId: chat.sessionId,
            ownerPid: chat.pid,
            worktreePath: chat.worktreePath,
          },
          'Chat purged after owner process exited',
        )
        changed = true
      }
    }
    if (changed) this.onChanged?.(this.snapshot)
  }

  close(): void {
    if (!this.closed)
      log.info({ chatCount: this.chats.size }, 'Chat store closing')
    this.closed = true
    this.onChanged = undefined
    this.onTurnFinished = undefined
    clearInterval(this.timer)
  }
}
