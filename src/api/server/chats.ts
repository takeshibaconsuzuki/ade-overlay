/**
 * Single source of truth for the live-chat HTTP surface shared between the
 * Fastify server and the unprivileged renderer.
 *
 * Lives in `src/api/server`, the node-free shared boundary: the server schema
 * (`chats/schemas.ts`) builds its Zod types from these names and the renderer
 * registers SSE listeners from them. Keep it dependency-free (no `node:*`, no
 * Zod) to preserve that boundary.
 *
 * A chat is a single conversation inside an agentic coding system. Its status
 * is a coarse lifecycle the launcher can render at a glance:
 *   - `busy`    the agent is actively working.
 *   - `idle`    the agent is waiting for user input.
 *   - `dormant` the chat has ended; it is not shown in the launcher.
 */
export const CHAT_STATUS = {
  dormant: 'dormant',
  idle: 'idle',
  busy: 'busy',
} as const

export type ChatStatus = (typeof CHAT_STATUS)[keyof typeof CHAT_STATUS]

/**
 * Incremental change-event names for the chat stream. The `snapshot` event is
 * intentionally excluded: it carries the full initial state, not a change.
 */
export const CHAT_EVENT_TYPE = {
  chatUpdated: 'chat-updated',
} as const

export type ChatEventType =
  (typeof CHAT_EVENT_TYPE)[keyof typeof CHAT_EVENT_TYPE]

export const CHAT_EVENT_TYPES: readonly ChatEventType[] =
  Object.values(CHAT_EVENT_TYPE)

/** Stable identifiers for each supported agentic coding system. */
export const CHAT_PROVIDER = {
  claude: 'claude',
  codex: 'codex',
} as const

export type ChatProviderId = (typeof CHAT_PROVIDER)[keyof typeof CHAT_PROVIDER]

/**
 * Base path agentic coding systems POST hook events to. The concrete provider
 * id is appended as a path segment, e.g. `/chats/hooks/claude`.
 */
export const CHAT_HOOKS_PATH = '/chats/hooks'

/** SSE path the launcher subscribes to for live chat status. */
export const CHAT_STREAM_PATH = '/chats'
