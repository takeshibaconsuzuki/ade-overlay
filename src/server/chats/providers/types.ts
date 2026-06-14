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
}

/** Identifies a worktree to configure hooks for. */
export type WorktreeRef = {
  worktreeId: string
  path: string
}

/**
 * Out-of-band context the server knows about a hook call, independent of the
 * payload. `worktreeId` is encoded into the hook URL at configure time, so it
 * authoritatively identifies the worktree the chat belongs to — no need to
 * trust the payload's reported working directory.
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
}

/** Slow-resolved chat details, used to backfill what live events omit. */
export type ChatDetails = {
  title?: string
  description?: string
}
