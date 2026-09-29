import { z } from 'zod'
import { eventSpec, requestSpec } from './rpc.ts'
import { terminalPasteSchema, pasteTargetSchema } from './paste-schema.ts'
import { worktreeColorSchema } from './worktree-colors.ts'

export const chatIdSchema = z.string().min(1).max(128)
export const processIdentitySchema = z.object({
  pid: z.int().positive(),
  startedAt: z.string().min(1).max(128),
})
const chatActivitySchema = z.enum(['idle', 'working'])
const chatTextSchema = z.string().max(4000)
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
  terminalId: chatIdSchema,
  path: z.string(),
  color: worktreeColorSchema.optional(),
  title: z.string().max(512).optional(),
  message: chatTextSchema.optional(),
  activity: chatActivitySchema,
})
const chatSnapshotSchema = z.object({
  chats: z.array(chatSchema),
})
export const chatRequests = {
  paste: requestSpec('paste', terminalPasteSchema, z.null(), 5_000),
  pasteTarget: requestSpec(
    'paste-target',
    z.null(),
    pasteTargetSchema.nullable(),
    5_000,
  ),
  activate: requestSpec('activate', chatIdSchema, z.null(), 35_000),
}
export const chatEvents = {
  snapshot: eventSpec('snapshot', chatSnapshotSchema),
  focus: eventSpec(
    'focus',
    z.object({ id: chatIdSchema, terminalId: chatIdSchema }),
  ),
  cancelFocus: eventSpec('cancel-focus', chatIdSchema),
  focused: eventSpec(
    'focused',
    z.object({ id: chatIdSchema, error: z.string().max(1024).optional() }),
  ),
}
export type ProcessIdentity = z.infer<typeof processIdentitySchema>
export type ChatActivity = z.infer<typeof chatActivitySchema>
export type ChatReport = z.infer<typeof chatReportSchema>
export type Chat = z.infer<typeof chatSchema>
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>
