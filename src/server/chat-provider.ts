import type { Chat } from '../shared/api'

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
  readReport(report: unknown): Promise<Chat>
}
