import type { Chat } from '../../src/shared/api'

export type SidebarMessage =
  { type: 'ready' } | { type: 'startCodex' } | { type: 'openChat'; id: string }

export interface ChatsMessage {
  type: 'chats'
  // Undefined means a current snapshot is not available yet.
  chats: Record<string, Chat> | undefined
  // The selected terminal remains active while focus moves into the sidebar.
  activeTerminalId: string | undefined
}
