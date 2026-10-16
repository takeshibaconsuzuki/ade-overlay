import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { Chat } from '../../../shared/api'
import type { ChatProvider, ChatReport } from '../../chat-provider'
import { findWorktreeRoot } from '../../git-utils'
import { HOOK_MARKER, installHooks } from '../hooks-file'
import {
  CLAUDE_CHAT_EVENTS,
  ClaudeChatReport,
  claudeReportSchema,
} from './report'

export class ClaudeChatProvider implements ChatProvider {
  readonly id = 'claude'
  readonly name = 'Claude Code'
  readonly defaultCommand = 'claude'

  // Hooks are installed in the directory's user settings. Session metadata is
  // read by the Agent SDK, which selects its directory from the environment.
  constructor(
    private readonly command: readonly [string, ...string[]],
    private readonly directory = resolve(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    ),
  ) {}

  async install(): Promise<void> {
    await access(this.command[0])
    const [command, ...args] = this.command
    // Exec form runs the reporter without a shell, so no platform quoting applies.
    const handler = {
      type: 'command',
      command,
      args: [...args, this.id, 'claude', HOOK_MARKER],
      timeout: 3,
    }
    await installHooks(
      join(this.directory, 'settings.json'),
      Object.fromEntries(
        CLAUDE_CHAT_EVENTS.map((event) => [
          event,
          {
            // Stop does not run after an interrupt; the idle prompt is the next signal.
            ...(event === 'Notification' ? { matcher: 'idle_prompt' } : {}),
            // The reporter must find its owner before Claude Code exits.
            hooks: [{ ...handler, async: event !== 'SessionEnd' }],
          },
        ]),
      ),
    )
  }

  async readReport(value: unknown): Promise<ChatReport> {
    const mtime = Date.now()
    const report = claudeReportSchema.parse(value)
    const working =
      report.hook_event_name === 'UserPromptSubmit' ||
      report.hook_event_name === 'PreToolUse' ||
      report.hook_event_name === 'PostToolUse' ||
      report.hook_event_name === 'PostToolUseFailure'
    const [info, worktreePath] = await Promise.all([
      getSessionInfo(report.session_id),
      // TODO: Use an environment variable supplied by ADE for the worktree path.
      findWorktreeRoot(report.cwd),
    ])
    const chat: Chat = {
      providerId: this.id,
      sessionId: report.session_id,
      terminalId: report.terminalId,
      mtime,
      lastActivityAt:
        report.hook_event_name === 'UserPromptSubmit' ||
        report.hook_event_name === 'Stop' ||
        report.hook_event_name === 'StopFailure'
          ? mtime
          : undefined,
      // The SDK's display title prefers saved or generated titles over prompts.
      title: info?.summary || '(no message yet)',
      description: report.prompt ?? report.last_assistant_message ?? undefined,
      worktreePath,
      pid: report.pid,
      status: working ? 'working' : 'idle',
    }
    return new ClaudeChatReport(chat, report)
  }
}
