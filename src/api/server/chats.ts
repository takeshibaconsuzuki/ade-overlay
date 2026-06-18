import { z } from 'zod/v4'
import { defineSseEvents, SSE_SNAPSHOT_EVENT } from './sse'

/**
 * Single source of truth for the live-chat HTTP surface shared between the
 * Fastify server and the unprivileged renderer.
 *
 * Lives in `src/api/server`, the shared boundary: the server registers these
 * Zod schemas and the renderer validates stream payloads with them.
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
export const CHAT_STREAM_PATH = '/chats/live'

/**
 * The chat app is a separate Electron role that hosts terminals running chat
 * sessions. These paths coordinate it, mirroring the editor surface
 * (`src/api/server/editor.ts`):
 *   - `POST /showChat` spawns + brings the chat app forward.
 *   - `GET /chats/live` streams live chat status.
 *   - `GET /chats/history` lists a worktree's historical (on-disk) sessions.
 *   - `GET /chats/commands` is the SSE stream the chat process listens to.
 */
export const CHAT_SHOW_PATH = '/showChat'
export const CHAT_HISTORY_PATH = '/chats/history'
export const CHAT_COMMAND_STREAM_PATH = '/chats/commands'

export const ChatStatus = z.enum([
  CHAT_STATUS.dormant,
  CHAT_STATUS.idle,
  CHAT_STATUS.busy,
])

export const Chat = z.object({
  chatId: z.string(),
  providerId: z.string(),
  status: ChatStatus,
  title: z.string().optional(),
  description: z.string().optional(),
  worktreeId: z.string().optional(),
  terminalId: z.string().optional(),
  updatedAt: z.number(),
})

export const ChatSnapshot = z.object({
  chats: z.array(Chat),
})

export const ChatEvent = z.object({
  type: z.literal(CHAT_EVENT_TYPE.chatUpdated),
  chat: Chat,
  snapshot: ChatSnapshot,
})

export const ChatSseEvents = defineSseEvents({
  [SSE_SNAPSHOT_EVENT]: ChatSnapshot,
  [CHAT_EVENT_TYPE.chatUpdated]: ChatEvent,
})

export const ChatStreamResponse = z
  .string()
  .describe('Server-sent live chat snapshot and events.')

export const ChatHookParams = z.object({
  providerId: z.string().min(1),
})

export const ChatHookQuery = z.object({
  worktreeId: z.string().optional(),
})

export const ChatHookPayload = z.looseObject({})

export const ChatHookResponse = z.object({
  ok: z.boolean(),
})

export const ChatSession = z.object({
  sessionId: z.string(),
  providerId: z.string(),
  worktreeId: z.string(),
  title: z.string().optional(),
  updatedAt: z.number(),
})

export const ChatHistoryResponse = z.object({
  sessions: z.array(ChatSession),
})

export const ChatShowRequest = z.union([
  z.strictObject({
    worktreeId: z.string().min(1),
  }),
  z.strictObject({
    worktreeId: z.string().min(1),
    providerId: z.string().min(1),
    chatId: z.string().min(1),
  }),
])

export const ChatShowResponse = z.object({
  ok: z.boolean(),
})

export const ChatHistoryQuery = z.object({
  worktreeId: z.string().min(1),
})

export const ChatCommandStreamResponse = z
  .string()
  .describe('Server-sent chat window commands.')

/**
 * Commands streamed to the chat Electron process over the SSE command stream.
 * `show` brings the already-spawned chat window forward. When it carries a
 * target chat (a live chat clicked from another window, e.g. the launcher), the
 * server includes the resolved terminal id for the renderer to select.
 */
export type ChatShowCommand =
  | {
      type: 'show'
    }
  | {
      type: 'show'
      providerId: string
      chatId: string
      terminalId: string
    }

export type ChatCommand = ChatShowCommand

export const ChatShowCommand = z.union([
  z.strictObject({
    type: z.literal('show'),
  }),
  z.strictObject({
    type: z.literal('show'),
    providerId: z.string().min(1),
    chatId: z.string().min(1),
    terminalId: z.string().min(1),
  }),
])

export const ChatCommand = ChatShowCommand

export const ChatCommandSseEvents = defineSseEvents({
  show: ChatCommand,
})

export type Chat = z.infer<typeof Chat>
export type ChatSnapshot = z.infer<typeof ChatSnapshot>
export type ChatEvent = z.infer<typeof ChatEvent>
export type ChatSession = z.infer<typeof ChatSession>
export type ChatSseEvents = typeof ChatSseEvents
export type ChatCommandSseEvents = typeof ChatCommandSseEvents
