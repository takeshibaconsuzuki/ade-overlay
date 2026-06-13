import { z } from 'zod/v4'
import { WORKTREE_ID_LENGTH } from '../worktrees/ids'
import { ErrorResponse } from '../worktrees/schemas'

export const OpenCodeRequest = z.object({
  worktreeId: z.string().length(WORKTREE_ID_LENGTH),
})

export const OpenCodeResponse = z.object({
  worktreeId: z.string(),
  url: z.string(),
  alreadyStarted: z.boolean(),
})

export const EditorCommandAckRequest = z.object({
  commandId: z.string().min(1),
})

export const EditorCommandAckResponse = z.object({
  ok: z.literal(true),
})

export { ErrorResponse }

export type EditorCommandAckRequest = z.infer<typeof EditorCommandAckRequest>
export type EditorCommandAckResponse = z.infer<typeof EditorCommandAckResponse>
export type OpenCodeRequest = z.infer<typeof OpenCodeRequest>
export type OpenCodeResponse = z.infer<typeof OpenCodeResponse>
