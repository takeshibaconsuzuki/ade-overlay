import { z } from 'zod'

export const worktreeColorSchema = z.enum([
  'blue',
  'orange',
  'green',
  'purple',
  'pink',
  'cyan',
  'yellow',
  'red',
])
export type WorktreeColor = z.infer<typeof worktreeColorSchema>
