import {
  ChatHistory,
  ChatHistoryIndex,
  type ChatHistoryIndexer,
} from '../../src/server/chat-history'
import type { ChatProvider } from '../../src/server/chat-provider'

// Updates the index in this process.
export class LocalChatHistoryIndexer implements ChatHistoryIndexer {
  constructor(
    private readonly path: string,
    private readonly providers: readonly ChatProvider[],
  ) {}

  async update(): Promise<void> {
    const index = new ChatHistoryIndex(this.path)
    try {
      await index.update(this.providers)
    } finally {
      index.close()
    }
  }

  async close(): Promise<void> {}
}

// A history that stays empty, for servers whose tests do not search it.
export function emptyChatHistory(): ChatHistory {
  return new ChatHistory(':memory:', {
    update: async () => {},
    close: async () => {},
  })
}
