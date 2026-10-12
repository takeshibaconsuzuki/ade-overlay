import type { Chat } from '../../src/shared/api'

export interface ChatsMessage {
  type: 'chats'
  // Undefined means a current snapshot is not available yet.
  chats: Record<string, Chat> | undefined
}
