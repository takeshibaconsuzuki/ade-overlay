import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ChatActivity } from '../shared/chats.ts'
import type { ChatProcess } from './chat-processes.ts'

const hookInputSchema = z.object({
  session_id: z.string().min(1).max(128),
  hook_event_name: z.string(),
  source: z.string().optional(),
  tool_name: z.string().optional(),
  prompt: z.string().optional(),
  last_assistant_message: z.string().nullable().optional(),
})
export interface ChatProvider {
  id: string
  hookFile(env: NodeJS.ProcessEnv): string
  events: readonly string[]
  hookCommand(args: readonly string[]): Record<string, unknown>
  activity(
    input: unknown,
  ):
    | {
        sessionId: string
        activity: ChatActivity
        message?: string
        turnEvent?: boolean
      }
    | undefined
  isProcess(entry: ChatProcess): boolean
  metadataRoot(env: NodeJS.ProcessEnv): string
  readTitle(root: string, sessionId: string): Promise<string | undefined>
}

// Provider knowledge stays here; registry and navigation consume normalized data.
export const codexProvider: ChatProvider = {
  id: 'codex',
  hookFile: (env) =>
    join(env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'),
  metadataRoot: (env) => env.CODEX_HOME || join(homedir(), '.codex'),
  readTitle: async (root, sessionId) =>
    (await import('./codex-chat-title.ts')).readCodexTitle(root, sessionId),
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

export const chatProviders: readonly ChatProvider[] = [codexProvider]
export function chatProvider(id: string): ChatProvider | undefined {
  return chatProviders.find((provider) => provider.id === id)
}
