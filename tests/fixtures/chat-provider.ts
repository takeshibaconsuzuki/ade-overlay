import type { ChatProvider, ChatReport } from '../../src/server/chat-provider'
import type { Chat } from '../../src/shared/api'

export class TestChatProvider implements ChatProvider {
  constructor(readonly id = 'test') {}
  async install(): Promise<void> {}
  async readReport(value: unknown): Promise<ChatReport> {
    return { shouldPurge: false, chat: value as Chat }
  }
}
