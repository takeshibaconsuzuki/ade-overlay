import type { Chat } from '../../src/shared/api'

export type SidebarMessage =
  { type: 'ready' } | { type: 'startCodex' } | { type: 'openChat'; id: string }

export interface ChatsMessage {
  type: 'chats'
  // Undefined means a current snapshot is not available yet.
  chats: Record<string, Chat> | undefined
  // The last focused live chat in this worktree, with a fallback while chats exist.
  selectedChatId: string | undefined
}
