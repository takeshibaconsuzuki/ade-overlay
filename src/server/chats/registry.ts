import { EventEmitter } from 'node:events'
import { type Logger } from '../../api/server/logger'
import { CHAT_EVENT_TYPE } from '../../api/server/chats'
import {
  type ChatHookContext,
  type ChatProvider,
  type WorktreeRef,
} from './providers/types'
import { type Chat, type ChatEvent, type ChatSnapshot } from './schemas'

/**
 * How long to wait after a chat first appears before reading its details from
 * the transcript. Gives the agent time to write its first message / summary.
 */
const DETAILS_RESOLVE_DELAY_MS = 2000

/**
 * In-memory map of live chats across every agentic coding system. Hook events
 * mutate the map and fan out over the chat event stream; the map is transient
 * and rebuilt from scratch on a full app restart.
 */
export class ChatRegistry {
  readonly events = new EventEmitter()

  private readonly chats = new Map<string, Chat>()
  private readonly providers = new Map<string, ChatProvider>()
  // Chats whose detail read has already been scheduled, so we only do it once.
  private readonly detailsResolved = new Set<string>()

  constructor(
    private readonly log: Logger,
    providers: ChatProvider[],
  ) {
    for (const provider of providers) {
      this.providers.set(provider.id, provider)
    }
  }

  /** Merge every provider's hook endpoint into a worktree's config files. */
  async configureWorktree(worktree: WorktreeRef): Promise<void> {
    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        try {
          await provider.configureWorktree(worktree)
        } catch (error) {
          this.log.warn(
            {
              err: error,
              provider: provider.id,
              worktreeId: worktree.worktreeId,
            },
            'failed to configure worktree chat hooks',
          )
        }
      }),
    )
  }

  /**
   * Apply a raw provider hook payload to the live map and broadcast the change.
   * Unknown fields are preserved from the previous chat state so a status-only
   * event (e.g. `Stop`) does not erase the title/description. Title and
   * description are read from the transcript once, lazily, the first time a
   * chat appears (see {@link scheduleDetails}).
   */
  applyHook(
    providerId: string,
    payload: Record<string, unknown>,
    context: ChatHookContext = {},
  ): void {
    const provider = this.providers.get(providerId)
    if (!provider) {
      this.log.warn({ providerId }, 'hook for unknown chat provider')
      return
    }

    const update = provider.mapHook(payload, context)
    if (!update) {
      return
    }

    const previous = this.chats.get(update.chatId)
    const chat: Chat = {
      chatId: update.chatId,
      providerId,
      status: update.status,
      // Both fall back to the previous value when an event carries no fresh one.
      title: update.title ?? previous?.title,
      description: update.description ?? previous?.description,
      worktreeId: update.worktreeId ?? previous?.worktreeId,
      updatedAt: Date.now(),
    }
    this.chats.set(chat.chatId, chat)

    this.log.info(
      { chatId: chat.chatId, providerId, status: chat.status },
      'chat status updated',
    )
    this.emit({
      type: CHAT_EVENT_TYPE.chatUpdated,
      chat,
      snapshot: this.getSnapshot(),
    })

    if (!this.detailsResolved.has(chat.chatId)) {
      this.detailsResolved.add(chat.chatId)
      this.scheduleDetails(provider, chat.chatId, payload)
    }
  }

  /**
   * Resolve a chat's title and description from the transcript once, a short
   * while after it first appears, then broadcast. Only fills in fields the chat
   * is still missing — live events take precedence over this slow fallback.
   * Best-effort: failures and empty results are ignored.
   */
  private scheduleDetails(
    provider: ChatProvider,
    chatId: string,
    payload: Record<string, unknown>,
  ): void {
    const timer = setTimeout(() => {
      void provider
        .resolveDetails(payload)
        .then((details) => {
          const chat = this.chats.get(chatId)
          if (!chat) {
            return
          }
          // Backfill only what's missing; a live event may have set it first.
          const title = chat.title ?? details.title
          const description = chat.description ?? details.description
          if (title === chat.title && description === chat.description) {
            return
          }
          const next = { ...chat, title, description }
          this.chats.set(chatId, next)
          this.emit({
            type: CHAT_EVENT_TYPE.chatUpdated,
            chat: next,
            snapshot: this.getSnapshot(),
          })
        })
        .catch((error: unknown) => {
          this.log.warn(
            { err: error, chatId },
            'failed to resolve chat details',
          )
        })
    }, DETAILS_RESOLVE_DELAY_MS)
    // Don't let a pending detail read keep the process alive on shutdown.
    timer.unref()
  }

  getSnapshot(): ChatSnapshot {
    const chats = [...this.chats.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    )
    return { chats }
  }

  private emit(event: ChatEvent): void {
    this.events.emit('chat-event', event)
  }
}
