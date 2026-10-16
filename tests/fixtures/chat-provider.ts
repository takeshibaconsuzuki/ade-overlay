import type { ChatProvider, ChatReport } from '../../src/server/chat-provider'
import type { Chat } from '../../src/shared/api'

export class TestChatProvider implements ChatProvider {
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
}
