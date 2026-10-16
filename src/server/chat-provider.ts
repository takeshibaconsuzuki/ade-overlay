import type { Chat, ChatProviderInfo } from '../shared/api'

export interface ChatReport {
  shouldPurge: boolean
  chat: Chat
  // Runs synchronously in receipt order after a successful read, with the stored chat.
  // Return undefined to ignore an update; retain its provider and session IDs.
  transformChat?(previous: Readonly<Chat> | undefined): Chat | undefined
}

const sessionStartGraceMs = 1000

export function isLateSessionStart(
  chat: Readonly<Chat>,
  previous: Readonly<Chat> | undefined,
): boolean {
  return (
    previous?.status === 'working' &&
    chat.mtime - previous.mtime < sessionStartGraceMs
  )
}

export class UnknownChatProviderError extends Error {
  constructor(providerId: string) {
    super(`Unknown chat provider: ${providerId}`)
  }
}

export interface ChatProvider extends ChatProviderInfo {
  // Stable namespace for session IDs and incoming reports.
  readonly id: string
  readonly name: string
  readonly defaultCommand: string
  install(): Promise<void>
  // Capture mtime before asynchronous work; undefined fields retain stored values.
  readReport(report: unknown): Promise<ChatReport>
}
