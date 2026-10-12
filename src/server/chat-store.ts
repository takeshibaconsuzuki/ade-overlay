import { chatSchema, type Chat } from '../shared/api'
import { logger } from '../shared/logger'
import { UnknownChatProviderError, type ChatProvider } from './chat-provider'
import type { ProcessProbe } from './process-probe'

const log = logger.child({ component: 'chat-store' })
// This is a live registry; a restarted server is repopulated by subsequent hooks.
export class ChatStore {
  private readonly chats = new Map<string, Chat>()
  private pending = Promise.resolve()
  private readonly timer: NodeJS.Timeout
  private closed = false
  private onChanged: ((snapshot: Record<string, Chat>) => void) | undefined

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
      const incoming = chatSchema.parse(result.value)
      const id = `${incoming.providerId}:${incoming.sessionId}`
      const chat = chatSchema.parse({
        ...this.chats.get(id),
        ...Object.fromEntries(
          Object.entries(incoming).filter(([, value]) => value !== undefined),
        ),
      })
      this.chats.set(id, chat)
      this.onChanged?.(this.snapshot)
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
        changed = true
      }
    }
    if (changed) this.onChanged?.(this.snapshot)
  }

  close(): void {
    this.closed = true
    this.onChanged = undefined
    clearInterval(this.timer)
  }
}
