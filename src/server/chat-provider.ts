import { z } from 'zod'
import { chatSchema } from '../shared/api'

export const chatReportSchema = z.object({
  shouldPurge: z.boolean(),
  chat: chatSchema,
})

export type ChatReport = z.infer<typeof chatReportSchema>

export class UnknownChatProviderError extends Error {
  constructor(providerId: string) {
    super(`Unknown chat provider: ${providerId}`)
  }
}

export interface ChatProvider {
  // Stable namespace for session IDs and incoming reports.
  readonly id: string
  install(): Promise<void>
  // Capture mtime before asynchronous work; undefined fields retain stored values.
  readReport(report: unknown): Promise<ChatReport>
}
