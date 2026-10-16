import { z } from 'zod'
import type { Chat } from '../../../shared/api'
import { isLateSessionStart, type ChatReport } from '../../chat-provider'

export const CLAUDE_CHAT_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const

// Claude Code's original hook payload, with ownership attached by the reporter.
export const claudeReportSchema = z.object({
  session_id: z.string().trim().min(1),
  hook_event_name: z.enum(CLAUDE_CHAT_EVENTS),
  cwd: z.string().min(1),
  terminalId: z.uuid().optional(),
  pid: z
    .int()
    .positive()
    .max(2 ** 31 - 1),
  source: z.string().optional(),
  prompt: z.string().optional(),
  last_assistant_message: z.string().nullable().optional(),
  agent_id: z.string().optional(),
})

type ClaudeReport = z.infer<typeof claudeReportSchema>

export class ClaudeChatReport implements ChatReport {
  readonly shouldPurge: boolean

  constructor(
    readonly chat: Chat,
    private readonly report: ClaudeReport,
  ) {
    this.shouldPurge = report.hook_event_name === 'SessionEnd'
  }

  transformChat(previous: Readonly<Chat> | undefined): Chat | undefined {
    // Subagents report under their parent's session but do not share its turn.
    // Accepted tradeoff: a subagent waiting for permission leaves the chat working.
    if (this.report.agent_id !== undefined) return undefined
    if (this.report.hook_event_name !== 'SessionStart') return this.chat
    // Compaction continues the session in its current state, mid-turn or idle.
    if (this.report.source === 'compact')
      return { ...this.chat, status: previous?.status ?? this.chat.status }
    return isLateSessionStart(this.chat, previous) ? undefined : this.chat
  }
}
