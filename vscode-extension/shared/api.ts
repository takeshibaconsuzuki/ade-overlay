import type { Chat } from '../../src/shared/api'

export type SidebarMessage =
  { type: 'ready' } | { type: 'openChat'; id: string }

export interface ChatsMessage {
  type: 'chats'
  // Undefined means a current snapshot is not available yet.
  chats: Record<string, Chat> | undefined
}
