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

export type Chat = z.infer<typeof Chat>
export type ChatSnapshot = z.infer<typeof ChatSnapshot>
export type ChatEvent = z.infer<typeof ChatEvent>
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>
