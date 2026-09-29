import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ChatActivity } from '../../shared/chats.ts'
import type { ChatProcess } from '../../shared/node/chat-processes.ts'

const hookInputSchema = z.object({
  session_id: z.string().min(1).max(128),
  hook_event_name: z.string(),
  source: z.string().optional(),
  tool_name: z.string().optional(),
  prompt: z.string().optional(),
  last_assistant_message: z.string().nullable().optional(),
})
const claudeHookInputSchema = hookInputSchema.extend({
  agent_id: z.string().optional(),
  notification_type: z.string().optional(),
  is_interrupt: z.boolean().optional(),
  trigger: z.enum(['manual', 'auto']).optional(),
})
// Metadata home -> requested live sessions / available titles.
export type ChatTitleRequests = ReadonlyMap<string, ReadonlySet<string>>
export type ChatTitles = Map<string, Map<string, string>>

export interface ChatProvider {
  id: string
  hookFile(env: NodeJS.ProcessEnv): string
  events: readonly string[]
  hookCommand(args: readonly string[]): Record<string, unknown>
  activity(input: unknown):
    | {
        sessionId: string
        activity: ChatActivity
        message?: string
        turnEvent?: boolean
      }
    | undefined
  isProcess(entry: ChatProcess): boolean
  metadataRoot(env: NodeJS.ProcessEnv): string
  readTitles(requests: ChatTitleRequests): Promise<ChatTitles>
}

// Provider knowledge stays here; registry and navigation consume normalized data.
export const codexProvider: ChatProvider = {
  id: 'codex',
  hookFile: (env) =>
    join(env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'),
  metadataRoot: (env) => env.CODEX_HOME || join(homedir(), '.codex'),
  readTitles: async (requests) =>
    (await import('./codex-chat-title.ts')).readCodexTitles(requests),
  events: [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'Stop',
    'Interrupt',
  ],
  hookCommand: (args) => ({
    type: 'command',
    command: args
      .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
      .join(' '),
    commandWindows:
      '& ' + args.map((value) => `'${value.replaceAll("'", "''")}'`).join(' '),
    timeout: 3,
  }),
  activity(raw) {
    const input = hookInputSchema.safeParse(raw).data
    if (!input || !this.events.includes(input.hook_event_name)) return
    // Compaction's SessionStart is a continuation of active work, not a new idle chat.
    const working =
      input.hook_event_name === 'UserPromptSubmit' ||
      input.hook_event_name === 'PostToolUse' ||
      (input.hook_event_name === 'PreToolUse' &&
        input.tool_name !== 'request_user_input') ||
      (input.hook_event_name === 'SessionStart' && input.source === 'compact')
    return {
      sessionId: input.session_id,
      activity: working ? 'working' : 'idle',
      turnEvent:
        input.hook_event_name === 'UserPromptSubmit' ||
        input.hook_event_name === 'Stop',
      ...(input.hook_event_name === 'UserPromptSubmit'
        ? { message: input.prompt?.trim().slice(0, 4000) || undefined }
        : input.hook_event_name === 'Stop'
          ? {
              message:
                input.last_assistant_message?.trim().slice(0, 4000) ||
                undefined,
            }
          : {}),
    }
  },
  isProcess: (entry) =>
    /^codex(?:\.exe)?$/i.test(entry.name) ||
    (/^node(?:\.exe)?$/i.test(entry.name) &&
      /[\\/]@openai[\\/]codex[\\/]/i.test(entry.command)),
}

export const claudeProvider: ChatProvider = {
  id: 'claude',
  hookFile: (env) =>
    join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
  metadataRoot: (env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  readTitles: async (requests) =>
    (await import('./claude-chat-title.ts')).readClaudeTitles(requests),
  events: [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'Notification',
    'Stop',
    'StopFailure',
    'PreCompact',
    'PostCompact',
    'Elicitation',
    'ElicitationResult',
  ],
  // Claude's exec form preserves paths verbatim on every platform.
  hookCommand: ([command, ...args]) => ({
    type: 'command',
    command,
    args,
    timeout: 3,
  }),
  activity(raw) {
    const input = claudeHookInputSchema.safeParse(raw).data
    if (
      !input ||
      input.agent_id ||
      !this.events.includes(input.hook_event_name)
    )
      return
    const event = input.hook_event_name
    // Pre/PostCompact own activity: compact SessionStart cannot distinguish
    // a manual operation returning to the prompt from an automatic continuation.
    if (event === 'SessionStart' && input.source === 'compact') return
    // Auth and background-agent notifications do not change the main turn.
    if (
      event === 'Notification' &&
      !['permission_prompt', 'idle_prompt', 'elicitation_dialog'].includes(
        input.notification_type ?? '',
      )
    )
      return
    // Esc cancellation emits neither Stop nor a normal PostToolUseFailure.
    // Detecting it needs transcript/terminal monitoring; process liveness and
    // silence cannot distinguish cancellation from long-running work. Keep the
    // last state until another supported hook (including idle_prompt) arrives.
    const working =
      event === 'UserPromptSubmit' ||
      event === 'PostToolUse' ||
      (event === 'PostToolUseFailure' && !input.is_interrupt) ||
      event === 'PreCompact' ||
      (event === 'PostCompact' && input.trigger !== 'manual') ||
      event === 'ElicitationResult' ||
      (event === 'PreToolUse' &&
        !['AskUserQuestion', 'ExitPlanMode'].includes(input.tool_name ?? ''))
    return {
      sessionId: input.session_id,
      activity: working ? 'working' : 'idle',
      turnEvent: ['UserPromptSubmit', 'Stop', 'StopFailure'].includes(event),
      ...(event === 'UserPromptSubmit'
        ? { message: input.prompt?.trim().slice(0, 4000) || undefined }
        : event === 'Stop'
          ? {
              message:
                input.last_assistant_message?.trim().slice(0, 4000) ||
                undefined,
            }
          : {}),
    }
  },
  isProcess: (entry) =>
    /^claude(?:\.exe)?$/i.test(entry.name) ||
    (/^node(?:\.exe)?$/i.test(entry.name) &&
      /[\\/]@anthropic-ai[\\/]claude-code[\\/]/i.test(entry.command)),
}

export const chatProviders: readonly ChatProvider[] = [
  codexProvider,
  claudeProvider,
]
export function chatProvider(id: string): ChatProvider | undefined {
  return chatProviders.find((provider) => provider.id === id)
}
