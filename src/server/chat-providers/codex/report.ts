import { z } from 'zod'

export const CODEX_CHAT_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'Interrupt',
  'SessionEnd',
] as const

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
