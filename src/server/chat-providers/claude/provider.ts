import { access, glob, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Chat } from '../../../shared/api'
import type {
  ChatMessage,
  ChatProvider,
  ChatReport,
  ChatSession,
} from '../../chat-provider'
import { HOOK_MARKER, installHooks } from '../hooks-file'
import { readJsonLines } from '../utils'
import {
  CLAUDE_CHAT_EVENTS,
  ClaudeChatReport,
  claudeReportSchema,
} from './report'

const transcriptRecordSchema = z.object({
  type: z.enum(['user', 'assistant']),
  // Set on user records that are prompts. Other user records carry tool results, meta
  // context, compaction summaries, commands, shell escapes, and interruptions.
  promptSource: z.string().optional(),
  message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
})
const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() })

// The text of a user prompt or assistant reply; undefined for any other record.
function messageText(record: unknown): string | undefined {
  const result = transcriptRecordSchema.safeParse(record)
  if (!result.success) return undefined
  const { type, promptSource, message } = result.data
  // System prompts are notifications Claude Code generates, such as task results.
  if (
    type === 'user' &&
    (promptSource === undefined || promptSource === 'system')
  )
    return undefined
  const texts =
    typeof message.content === 'string'
      ? [message.content]
      : message.content.flatMap((block) => {
          const text = textBlockSchema.safeParse(block)
          return text.success ? [text.data.text] : []
        })
  return texts.length ? texts.join('\n') : undefined
}

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
    const info = await getSessionInfo(report.session_id)
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
      worktreePath: report.worktreePath,
      pid: report.pid,
      status: working ? 'working' : 'idle',
    }
    return new ClaudeChatReport(chat, report)
  }

  async listSessions(): Promise<ChatSession[]> {
    // Headless and SDK sessions persist and resume like interactive ones.
    const sessions = await listSessions({ includeProgrammatic: true })
    return sessions.map((session) => ({
      sessionId: session.sessionId,
      title: session.summary,
      cwd: session.cwd ?? '',
      modifiedAt: session.lastModified,
    }))
  }

  async *readMessages(
    sessionIds: readonly string[],
  ): AsyncGenerator<ChatMessage> {
    const paths = await this.transcriptPaths()
    for (const sessionId of sessionIds) {
      const path = paths.get(sessionId)
      if (!path) continue
      for await (const record of readJsonLines(path)) {
        const text = messageText(record)
        if (text !== undefined) yield { sessionId, text }
      }
    }
  }

  resumeCommand(command: string, sessionId: string): string {
    return `${command} --resume ${sessionId}`
  }

  private async transcriptPaths(): Promise<Map<string, string>> {
    // Session transcripts sit directly in project directories; subagents' are deeper.
    const projects = join(this.directory, 'projects')
    const candidates = new Map<string, string[]>()
    for await (const path of glob('*/*.jsonl', { cwd: projects })) {
      const id = basename(path, '.jsonl')
      candidates.set(id, [...(candidates.get(id) ?? []), join(projects, path)])
    }
    return new Map(
      await Promise.all(
        [...candidates].map(
          async ([id, paths]) => [id, await newest(paths)] as const,
        ),
      ),
    )
  }
}

// Like the Agent SDK, a session found in several project directories is its newest copy.
async function newest(paths: string[]): Promise<string> {
  if (paths.length === 1) return paths[0]
  const times = await Promise.all(
    paths.map(async (path) => (await stat(path)).mtimeMs),
  )
  return paths[times.indexOf(Math.max(...times))]
}
