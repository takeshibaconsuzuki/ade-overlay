import type {
  Chat,
  ChatHistoryResults,
  ChatProviderInfo,
} from '../../src/shared/api'
import type { RunningWorktree } from '../../src/shared/editor-rpc'

export type SidebarMessage =
  | { type: 'ready' }
  | { type: 'startChat'; providerId: string }
  | { type: 'openChat'; id: string }
  // A live session opens like openChat; any other resumes in this worktree.
  | { type: 'resumeChat'; providerId: string; sessionId: string }
  | { type: 'openTerminal' }
  | { type: 'openWorktree'; path: string }
  // The history tab's query, or undefined while the tab is not shown.
  | { type: 'searchHistory'; query: string | undefined }

export interface ChatsMessage {
  type: 'chats'
  // Undefined means a current snapshot is not available yet.
  chats: Record<string, Chat> | undefined
  providers: ChatProviderInfo[]
  selectedProviderId: string | undefined
  // The last focused live chat in this worktree, with a fallback while chats exist.
  selectedChatId: string | undefined
}

export interface WorktreesMessage {
  type: 'worktrees'
  // The leading running worktrees other than this window's, in picker order and
  // limited by the sidebar setting. Undefined until the desktop sends them.
  worktrees: RunningWorktree[] | undefined
}

// Sent for the current history query and again whenever the index or connection changes.
export interface HistoryMessage {
  type: 'history'
  query: string
  // Undefined while the server is unavailable or the search failed.
  results: ChatHistoryResults | undefined
}
