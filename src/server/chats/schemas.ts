import { z } from 'zod/v4'
import { CHAT_EVENT_TYPE, CHAT_STATUS } from '../../api/server/chats'

export const ChatStatus = z.enum([
  CHAT_STATUS.dormant,
  CHAT_STATUS.idle,
  CHAT_STATUS.busy,
])

export const Chat = z.object({
  // Provider-scoped conversation id (e.g. a Claude Code session id).
  chatId: z.string(),
  providerId: z.string(),
  status: ChatStatus,
  // Sticky conversation title — providers fill it from the most title-like
  // information they have (for Claude Code, the first user prompt). Absent until
  // the chat has produced one.
  title: z.string().optional(),
  // Live secondary line, e.g. the latest user prompt.
  description: z.string().optional(),
  // The worktree this chat is running in, matching a worktree snapshot row.
  worktreeId: z.string().optional(),
  updatedAt: z.number(),
})

export const ChatSnapshot = z.object({
  chats: z.array(Chat),
})

const ChatSnapshotEvent = z.object({
  type: z.literal('snapshot'),
  snapshot: ChatSnapshot,
})

export const ChatEvent = z.object({
  type: z.literal(CHAT_EVENT_TYPE.chatUpdated),
  chat: Chat,
  snapshot: ChatSnapshot,
})

export const ChatStreamEvent = z.union([ChatSnapshotEvent, ChatEvent])

export const ChatHookParams = z.object({
  providerId: z.string().min(1),
})

// Server-known context encoded into the hook URL at configure time.
export const ChatHookQuery = z.object({
  worktreeId: z.string().optional(),
})

// Hook payloads are provider-defined JSON objects; accept and forward unknown
// keys so each provider can interpret its own schema.
export const ChatHookPayload = z.looseObject({})

export const ChatHookResponse = z.object({
  ok: z.boolean(),
})

// A historical, on-disk chat session discovered for a worktree (see each
// provider's `listSessions`). `sessionId` is the provider-native id used to
// resume the conversation.
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

// A live server-hosted terminal running a chat session. Terminals outlive the
// chat window (their PTYs live in the server), so the reopened app re-lists
// them and re-attaches.
export const ChatTerminal = z.object({
  terminalId: z.string(),
  worktreeId: z.string(),
  providerId: z.string(),
  // Set when the terminal resumed a known session.
  sessionId: z.string().optional(),
  title: z.string().optional(),
  status: z.enum(['running', 'exited']),
})

export const ChatTerminalListResponse = z.object({
  terminals: z.array(ChatTerminal),
})

export const ChatTerminalCreateRequest = z.object({
  worktreeId: z.string().min(1),
  // Defaults to the Claude provider when omitted.
  providerId: z.string().optional(),
  // When set, resume this session instead of starting a fresh chat.
  resumeSessionId: z.string().optional(),
  // Optional label retained for the terminal (e.g. the resumed session's title)
  // so a reopened chat window can re-show the tab with a meaningful name.
  title: z.string().optional(),
})

export const ChatOpenRequest = z.strictObject({})

export const ChatOpenResponse = z.object({
  ok: z.boolean(),
})

export const ChatHistoryQuery = z.object({
  worktreeId: z.string().min(1),
})

export const ChatTerminalListQuery = z.object({
  worktreeId: z.string().optional(),
})

export const ChatTerminalParams = z.object({
  terminalId: z.string().min(1),
})

export type Chat = z.infer<typeof Chat>
export type ChatSnapshot = z.infer<typeof ChatSnapshot>
export type ChatEvent = z.infer<typeof ChatEvent>
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>
export type ChatSession = z.infer<typeof ChatSession>
export type ChatTerminal = z.infer<typeof ChatTerminal>
