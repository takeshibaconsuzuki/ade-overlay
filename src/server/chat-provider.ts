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

export interface ChatSession {
  sessionId: string
  title: string
  cwd: string
  // Unix milliseconds of the session's last recorded change; its messages can differ only
  // when this does.
  modifiedAt: number
}

export interface ChatMessage {
  sessionId: string
  // A user prompt or agent message.
  text: string
}

export interface ChatProvider extends ChatProviderInfo {
  // Stable namespace for session IDs and incoming reports.
  readonly id: string
  readonly name: string
  readonly defaultCommand: string
  install(): Promise<void>
  // Capture mtime before asynchronous work; undefined fields retain stored values.
  readReport(report: unknown): Promise<ChatReport>
  // Resumable sessions from every directory, without sessions that only serve another
  // session.
  listSessions(): Promise<ChatSession[]>
  // The messages of each session in order, one session after another. Unknown sessions
  // have none.
  readMessages(sessionIds: readonly string[]): AsyncIterable<ChatMessage>
  // Extends a provider command to resume the session in the directory the command runs in.
  resumeCommand(command: string, sessionId: string): string
}
