import type { ChatTerminalLaunch } from '../../src/shared/api'

export interface TerminalChatProvider {
  // The process must exit when the chat ends, without returning to a shell prompt.
  getLaunchOptions(): Pick<ChatTerminalLaunch, 'shellPath' | 'shellArgs'>
}
