import type {
  ChatMessage,
  ChatProvider,
  ChatReport,
  ChatSession,
} from '../../src/server/chat-provider'
import type { Chat } from '../../src/shared/api'

// Sessions and their messages are read as assigned.
export class TestChatProvider implements ChatProvider {
  sessions: ChatSession[] = []
  messages = new Map<string, string[]>()
  constructor(readonly id = 'test') {}
  get name(): string {
    return this.id[0].toUpperCase() + this.id.slice(1)
  }
  get defaultCommand(): string {
    return this.id
  }
  async install(): Promise<void> {}
  async readReport(value: unknown): Promise<ChatReport> {
    return { shouldPurge: false, chat: value as Chat }
  }
  async listSessions(): Promise<ChatSession[]> {
    return this.sessions
  }
  async *readMessages(
    sessionIds: readonly string[],
  ): AsyncGenerator<ChatMessage> {
    for (const sessionId of sessionIds)
      for (const text of this.messages.get(sessionId) ?? [])
        yield { sessionId, text }
  }
  resumeCommand(command: string, sessionId: string): string {
    return `${command} --resume ${sessionId}`
  }
}
