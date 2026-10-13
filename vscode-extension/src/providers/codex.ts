import type { TerminalChatProvider } from '../terminal-chat-provider'

export class CodexTerminalProvider implements TerminalChatProvider {
  getLaunchOptions() {
    // A command shell resolves npm's Windows shim as well as native executables.
    return process.platform === 'win32'
      ? {
          shellPath: process.env.ComSpec ?? 'cmd.exe',
          shellArgs: ['/d', '/c', 'codex'],
        }
      : { shellPath: '/bin/sh', shellArgs: ['-c', 'exec codex'] }
  }
}
