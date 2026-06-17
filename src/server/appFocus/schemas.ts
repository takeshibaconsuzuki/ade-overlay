import { z } from 'zod/v4'
import {
  ADE_APP_ROLE,
  APP_FOCUS_EVENT,
  type AdeAppRole,
  type AppFocusEvent,
} from '../../api/server/appFocus'

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
