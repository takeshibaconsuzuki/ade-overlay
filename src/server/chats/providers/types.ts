import { type ChatStatus } from '../../../api/server/chats'

/**
 * The result of interpreting a single provider hook event. Optional fields are
 * left out when the event carries no fresh value for them; the registry then
 * preserves whatever it already knows about the chat.
 */
export type ChatStatusUpdate = {
  chatId: string
  status: ChatStatus
  title?: string
  description?: string
  worktreeId?: string
  /**
   * When set, this event may have advanced the conversation with text the live
   * hook payload doesn't carry (a new user prompt, the assistant's mid-turn
   * narration, or its final reply), so the registry re-reads the transcript (via
   * {@link ChatProvider.resolveDescription}) and overwrites the description.
   */
  refreshDescription?: boolean
}

/** Identifies a worktree to configure hooks for. */
export type WorktreeRef = {
  worktreeId: string
  path: string
}

/**
 * Out-of-band context the server knows about a hook call, independent of the
 * payload. Managed hooks resolve `worktreeId` from process ancestry or the
 * forwarded runtime cwd.
 */
export type ChatHookContext = {
  worktreeId?: string
}

/**
 * Abstracts the differences between agentic coding systems behind a uniform
 * surface. Each implementation:
 *   - merges this server's hook endpoint into a worktree's configuration files
 *     so the agent calls back into us ({@link configureWorktree}), and
 *   - maps its own hook events onto a coarse chat status ({@link mapHook}),
 *     choosing the title/description from the most semantically similar
 *     information it has.
 */
export interface ChatProvider {
  readonly id: string

  /** Merge this server's hook endpoint into the worktree's config files. */
  configureWorktree(worktree: WorktreeRef): Promise<void>

  /**
   * Extract the provider-scoped chat id from any hook payload, including hooks
   * that should not create a live chat row. The registry uses this to bind
   * server-owned terminals as early as possible without treating session startup
   * itself as meaningful chat activity. A provider may derive this from its own
   * native session id internally; the abstraction only ever sees the chat id.
   */
  hookChatId(payload: Record<string, unknown>): string | undefined

  /**
   * Interpret a raw hook payload (plus server-known {@link ChatHookContext})
   * into a chat status update, or return `null` when the event is irrelevant or
   * unrecognized. Synchronous and cheap — it runs on every hook.
   */
  mapHook(
    payload: Record<string, unknown>,
    context: ChatHookContext,
  ): ChatStatusUpdate | null

  /**
   * Resolve human-friendly details for a chat from a hook payload, e.g. by
   * reading the session transcript. Called once per chat (lazily, shortly after
   * the chat first appears); may consult slow session artifacts. Fields are
   * omitted when unavailable. The registry only fills in details it is still
   * missing, so this is a fallback for what live events don't carry — notably
   * after a restart, when a chat reappears via a status-only event.
   */
  resolveDetails(payload: Record<string, unknown>): Promise<ChatDetails>

  /**
   * Resolve just the live description (the latest assistant text, or the latest
   * user prompt when no reply follows it) from a hook payload. Called on every
   * event that sets {@link ChatStatusUpdate.refreshDescription}, so it should be
   * cheap — read only the tail of the transcript, not the whole file. Returns
   * `undefined` when nothing usable is found.
   */
  resolveDescription(
    payload: Record<string, unknown>,
  ): Promise<string | undefined>

  /**
   * List the worktree's historical, on-disk chats, most-recent first. Read from
   * the agent's own session store (e.g. Claude Code's project transcripts), so
   * history survives app restarts and yields resumable chat ids. Best-effort:
   * return an empty list when the store is missing/unreadable.
   */
  listHistory(worktree: WorktreeRef): Promise<HistoricalChat[]>

  /** Command + args to resume an existing chat in the worktree's cwd. */
  resumeLaunch(chatId: string): ChatLaunch

  /** Command + args to start a fresh session in the worktree's cwd. */
  newLaunch(): ChatLaunch
}

/** Slow-resolved chat details, used to backfill what live events omit. */
export type ChatDetails = {
  title?: string
  description?: string
}

/** A historical chat discovered in a provider's on-disk store. */
export type HistoricalChat = {
  chatId: string
  title?: string
  description?: string
  /** Epoch milliseconds of the chat's last activity (for sorting). */
  updatedAt: number
}

/** A terminal launch: the executable to run and its argv. */
export type ChatLaunch = {
  command: string
  args: string[]
  /**
   * The chat id this launch will run as, when known up front (normally a resumed
   * chat). Recorded on the terminal so the live chat with the same id can be
   * matched back before the first hook lands. Fresh chats usually bind back to
   * their terminal from hook process metadata.
   */
  chatId?: string
}
