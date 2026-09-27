import { z } from 'zod'

export const chatIdSchema = z.string().min(1).max(128)
export const processIdentitySchema = z.object({
  pid: z.int().positive(),
  startedAt: z.string().min(1).max(128),
})
export const chatActivitySchema = z.enum(['idle', 'working'])
export const chatTextSchema = z.string().max(4000)
export const chatReportSchema = z.object({
  provider: chatIdSchema,
  sessionId: chatIdSchema,
  terminalId: chatIdSchema,
  process: processIdentitySchema,
  activity: chatActivitySchema,
  observedAt: z.number().finite().nonnegative(),
  metadataRoot: z.string().min(1).max(4096).optional(),
  message: chatTextSchema.optional(),
  turnEvent: z.boolean().optional(),
})
export const chatSchema = z.object({
  id: chatIdSchema,
  provider: chatIdSchema,
  sessionId: chatIdSchema,
  terminalId: chatIdSchema,
  project: z.string(),
  path: z.string(),
  title: z.string().max(512).optional(),
  message: chatTextSchema.optional(),
  lastTurnAt: z.number().finite().nonnegative().optional(),
  activity: chatActivitySchema,
})
export const chatSnapshotSchema = z.object({
  revision: z.int().nonnegative(),
  chats: z.array(chatSchema),
})
export const terminalInventorySchema = z
  .array(
    z.object({
      terminalId: chatIdSchema,
      pid: z.int().positive(),
      title: z.string().max(512),
      startedAt: z.string().min(1).max(128).optional(),
    }),
  )
  .max(512)
export const extensionChatMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('inventory'),
    id: chatIdSchema,
    terminals: terminalInventorySchema,
  }),
  z.object({
    type: z.literal('activate'),
    id: chatIdSchema,
    chatId: chatIdSchema,
  }),
  z.object({
    type: z.literal('focused'),
    id: chatIdSchema,
    error: z.string().max(1024).optional(),
  }),
])
export const serverChatMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: chatSnapshotSchema }),
  z.object({
    type: z.literal('focus'),
    id: chatIdSchema,
    terminalId: chatIdSchema,
  }),
  z.object({ type: z.literal('cancel-focus'), id: chatIdSchema }),
  z.object({
    type: z.literal('result'),
    id: chatIdSchema,
    error: z.string().max(1024).optional(),
    terminals: terminalInventorySchema.optional(),
  }),
])
export type ProcessIdentity = z.infer<typeof processIdentitySchema>
export type ChatActivity = z.infer<typeof chatActivitySchema>
export type ChatReport = z.infer<typeof chatReportSchema>
export type Chat = z.infer<typeof chatSchema>
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>
export type TerminalInventory = z.infer<typeof terminalInventorySchema>
export type ExtensionChatMessage = z.infer<typeof extensionChatMessageSchema>
export type ServerChatMessage = z.infer<typeof serverChatMessageSchema>
