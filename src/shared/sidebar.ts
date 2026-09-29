import { z } from 'zod'
import { chatIdSchema, chatSchema } from './chats.ts'

export const chatProviderOptions = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
] as const
export const launchProviderSchema = z.enum(
  chatProviderOptions.map(({ id }) => id),
)
export const launchKindSchema = z.enum([
  'terminal',
  ...launchProviderSchema.options,
])
export const sidebarActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({
    type: z.literal('select-provider'),
    provider: launchProviderSchema,
  }),
  z.object({ type: z.literal('launch'), kind: launchKindSchema }),
  z.object({ type: z.literal('activate'), chatId: chatIdSchema }),
])
export const sidebarStateSchema = z.object({
  type: z.literal('state'),
  chats: z.array(chatSchema),
  selectedProvider: launchProviderSchema,
  activeChatId: chatIdSchema.optional(),
  error: z.string().optional(),
})
export type SidebarAction = z.infer<typeof sidebarActionSchema>
export type SidebarState = z.infer<typeof sidebarStateSchema>
export type LaunchProvider = z.infer<typeof launchProviderSchema>
export type LaunchKind = z.infer<typeof launchKindSchema>
