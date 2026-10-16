import { z } from 'zod'
import type { Chat } from '../../../shared/api'
import { isLateSessionStart, type ChatReport } from '../../chat-provider'

export const CODEX_CHAT_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'Interrupt',
  'SessionEnd',
] as const

type CodexChatEvent = (typeof CODEX_CHAT_EVENTS)[number]

// Codex's original hook payload, with ownership attached by the reporter.
export const codexReportSchema = z.object({
  session_id: z.string().trim().min(1),
  hook_event_name: z.enum(CODEX_CHAT_EVENTS),
  cwd: z.string().min(1),
  terminalId: z.uuid().optional(),
  pid: z
    .int()
    .positive()
    .max(2 ** 31 - 1),
  source: z.string().optional(),
  prompt: z.string().optional(),
  last_assistant_message: z.string().nullable().optional(),
})

export class CodexChatReport implements ChatReport {
  readonly shouldPurge: boolean

  constructor(
    readonly chat: Chat,
    private readonly event: CodexChatEvent,
  ) {
    this.shouldPurge = event === 'SessionEnd'
  }

  transformChat(previous: Readonly<Chat> | undefined): Chat | undefined {
    return this.event === 'SessionStart' &&
      isLateSessionStart(this.chat, previous)
      ? undefined
      : this.chat
  }
}
