import { EventEmitter } from 'node:events'
import {
  CHAT_EVENT_TYPE,
  CHAT_STATUS,
  type Chat,
  type ChatEvent,
  type ChatSnapshot,
} from '../../api/server/chats'
import { type Logger } from '../../api/server/logger'
import { hookAncestorPids } from './hookForwarder'
import {
  type ChatHookContext,
  type ChatLaunch,
  type ChatProvider,
  type WorktreeRef,
} from './providers/types'

/**
 * How long to wait after a hook before reading the transcript. The hook can
 * fire just before the agent flushes the entry it describes, so reading
 * immediately lags a step behind; this delay lets the write land first.
 */
const TRANSCRIPT_READ_DELAY_MS = 1000

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
  // Resolves the terminal a chat is running in, injected by the owner that holds
  // the terminals. Lets the registry stamp `terminalId` onto every emitted chat
  // so clients never compute that join themselves (and so never disagree).
  private resolveTerminalId: (
    providerId: string,
    chatId: string,
  ) => string | undefined = () => undefined
  private bindTerminalSession: (
    providerId: string,
    worktreeId: string,
    chatId: string,
    hookAncestorPids?: number[],
  ) => string | undefined = () => undefined

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

    const hookChatId = provider.hookChatId(payload)
    if (hookChatId && context.worktreeId) {
      this.bindTerminalSession(
        providerId,
        context.worktreeId,
        hookChatId,
        hookAncestorPids(payload),
      )
    }

    const update = provider.mapHook(payload, context)
    if (!update) {
      return
    }

    const chatKey = `${providerId}:${update.chatId}`
    const previous = this.chats.get(chatKey)
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
    this.chats.set(chatKey, chat)

    this.log.info(
      { chatId: chat.chatId, providerId, status: chat.status },
      'chat status updated',
    )
    this.emit({
      type: CHAT_EVENT_TYPE.chatUpdated,
      chat,
      snapshot: this.getSnapshot(),
    })

    if (!this.detailsResolved.has(chatKey)) {
      // First appearance: a full details read backfills title and description.
      this.detailsResolved.add(chatKey)
      this.scheduleDetails(provider, chatKey, payload)
    } else if (update.refreshDescription) {
      // Re-read the transcript for the freshest description when the event
      // implies the conversation advanced (a new prompt or assistant text).
      this.refreshDescription(provider, chatKey, payload)
    }
  }

  /**
   * Re-read just the description from the transcript and overwrite it, in
   * response to an event that advanced the conversation. Unlike
   * {@link scheduleDetails} this runs on every such event (not once) and takes
   * precedence over the existing value. Best-effort: failures are logged.
   */
  private refreshDescription(
    provider: ChatProvider,
    chatKey: string,
    payload: Record<string, unknown>,
  ): void {
    // Delay the read: the hook can fire just before the agent flushes the entry
    // it describes, so reading immediately would lag a step behind.
    const timer = setTimeout(() => {
      void provider
        .resolveDescription(payload)
        .then((description) => {
          if (description === undefined) {
            return
          }
          const chat = this.chats.get(chatKey)
          if (!chat || chat.description === description) {
            return
          }
          const next = { ...chat, description }
          this.chats.set(chatKey, next)
          this.emit({
            type: CHAT_EVENT_TYPE.chatUpdated,
            chat: next,
            snapshot: this.getSnapshot(),
          })
        })
        .catch((error: unknown) => {
          this.log.warn(
            { err: error, chatId: chatKey },
            'failed to refresh chat description',
          )
        })
    }, TRANSCRIPT_READ_DELAY_MS)
    // Don't let a pending read keep the process alive on shutdown.
    timer.unref()
  }

  /**
   * Resolve a chat's title and description from the transcript once, a short
   * while after it first appears, then broadcast. Only fills in fields the chat
   * is still missing — live events take precedence over this slow fallback.
   * Best-effort: failures and empty results are ignored.
   */
  private scheduleDetails(
    provider: ChatProvider,
    chatKey: string,
    payload: Record<string, unknown>,
  ): void {
    const timer = setTimeout(() => {
      void provider
        .resolveDetails(payload)
        .then((details) => {
          const chat = this.chats.get(chatKey)
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
          this.chats.set(chatKey, next)
          this.emit({
            type: CHAT_EVENT_TYPE.chatUpdated,
            chat: next,
            snapshot: this.getSnapshot(),
          })
        })
        .catch((error: unknown) => {
          this.log.warn(
            { err: error, chatId: chatKey },
            'failed to resolve chat details',
          )
        })
    }, TRANSCRIPT_READ_DELAY_MS)
    // Don't let a pending detail read keep the process alive on shutdown.
    timer.unref()
  }

  /**
   * Aggregate every provider's historical, on-disk chats for a worktree as
   * `Chat`s, most-recent first. History is read from disk, so each chat is
   * marked `dormant`; the live registry's reactive entries (which the renderer
   * overlays by `(providerId, chatId)`) take precedence when a chat is currently
   * running. Per-provider failures are logged and skipped so one bad store never
   * hides the rest.
   */
  async listHistory(worktree: WorktreeRef): Promise<Chat[]> {
    const perProvider = await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        try {
          const history = await provider.listHistory(worktree)
          return history.map(
            (entry): Chat =>
              this.withTerminal({
                chatId: entry.chatId,
                providerId: provider.id,
                status: CHAT_STATUS.dormant,
                worktreeId: worktree.worktreeId,
                title: entry.title,
                description: entry.description,
                updatedAt: entry.updatedAt,
              }),
          )
        } catch (error) {
          this.log.warn(
            { err: error, provider: provider.id, path: worktree.path },
            'failed to list chat history',
          )
          return []
        }
      }),
    )

    return perProvider
      .flat()
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * Resolve the terminal launch (command + args) for a provider — resuming the
   * given session when provided, otherwise starting a fresh chat. Returns null
   * for an unknown provider id.
   */
  getLaunch(providerId: string, chatId?: string): ChatLaunch | null {
    const provider = this.providers.get(providerId)
    if (!provider) {
      return null
    }
    return chatId ? provider.resumeLaunch(chatId) : provider.newLaunch()
  }

  getSnapshot(): ChatSnapshot {
    const chats = [...this.chats.values()]
      .map((chat) => this.withTerminal(chat))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    return { chats }
  }

  /** Inject the terminal resolver used to stamp `terminalId` onto chats. */
  setTerminalResolver(
    resolve: (providerId: string, chatId: string) => string | undefined,
  ): void {
    this.resolveTerminalId = resolve
  }

  /**
   * Providers usually reveal a fresh session id only after the CLI starts. Bind
   * that first hook back to the server-owned terminal, preferring the managed
   * hook's process ancestry and falling back to one unambiguous unbound terminal
   * for older hook configurations.
   */
  setTerminalSessionBinder(
    bind: (
      providerId: string,
      worktreeId: string,
      chatId: string,
      hookAncestorPids?: number[],
    ) => string | undefined,
  ): void {
    this.bindTerminalSession = bind
  }

  /**
   * Re-broadcast the snapshot after a terminal change alters the chat↔terminal
   * join (e.g. a terminal started or exited), so clients refresh `terminalId`.
   */
  notifyTerminalsChanged(): void {
    this.events.emit('chat-snapshot', this.getSnapshot())
  }

  /** Stamp the terminal this app is running the chat in, if any. */
  private withTerminal(chat: Chat): Chat {
    return {
      ...chat,
      terminalId: this.resolveTerminalId(chat.providerId, chat.chatId),
    }
  }

  private emit(event: ChatEvent): void {
    this.events.emit('chat-event', {
      ...event,
      chat: this.withTerminal(event.chat),
    })
  }
}
