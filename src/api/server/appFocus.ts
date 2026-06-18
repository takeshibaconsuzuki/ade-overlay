import { z } from 'zod/v4'

export const APP_FOCUS_PATH = '/app-focus'

export const ADE_APP_ROLE = {
  chat: 'chat',
  editor: 'editor',
} as const

export type AdeAppRole = (typeof ADE_APP_ROLE)[keyof typeof ADE_APP_ROLE]

export const APP_FOCUS_EVENT = {
  closed: 'closed',
  focused: 'focused',
} as const

export type AppFocusEvent =
  (typeof APP_FOCUS_EVENT)[keyof typeof APP_FOCUS_EVENT]

export const AppFocusRequest = z.object({
  event: z.enum(
    Object.values(APP_FOCUS_EVENT) as [AppFocusEvent, ...AppFocusEvent[]],
  ),
  role: z.enum(Object.values(ADE_APP_ROLE) as [AdeAppRole, ...AdeAppRole[]]),
})

export const AppFocusResponse = z.object({
  ok: z.literal(true),
})

export type AppFocusRequest = z.infer<typeof AppFocusRequest>
export type AppFocusResponse = z.infer<typeof AppFocusResponse>
