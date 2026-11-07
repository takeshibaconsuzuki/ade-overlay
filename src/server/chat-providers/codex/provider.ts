import { existsSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from 'node:sqlite'
import { executePowerShell } from 'powershell-utils'
import { z } from 'zod'
import { quotePosixArgument } from '../../../shared/shell'
import type { Chat } from '../../../shared/api'
import type {
  ChatMessage,
  ChatProvider,
  ChatReport,
  ChatSession,
} from '../../chat-provider'
import { HOOK_MARKER, installHooks } from '../hooks-file'
import { readJsonLines } from '../utils'
import { CODEX_CHAT_EVENTS, CodexChatReport, codexReportSchema } from './report'

const metadataSchema = z.object({
  title: z.string(),
  name: z.string().nullable(),
  preview: z.string(),
  first_user_message: z.string(),
  history_mode: z.enum(['legacy', 'paginated']),
})
const sessionSchema = metadataSchema.extend({
  id: z.string(),
  rollout_path: z.string(),
  cwd: z.string(),
})
// Completed items carry the user prompts and agent messages as Codex displays them.
const transcriptRecordSchema = z.object({
  type: z.literal('event_msg'),
  payload: z.object({
    type: z.literal('item_completed'),
    item: z.object({
      type: z.enum(['UserMessage', 'AgentMessage']),
      content: z.array(z.unknown()),
    }),
  }),
})
const textPartSchema = z.object({ text: z.string() })
const indexEntrySchema = z.object({ id: z.string(), thread_name: z.string() })

// The text of a user prompt or agent message; undefined for any other record.
function messageText(record: unknown): string | undefined {
  const result = transcriptRecordSchema.safeParse(record)
  if (!result.success) return undefined
  const texts = result.data.payload.item.content.flatMap((part) => {
    const text = textPartSchema.safeParse(part)
    return text.success ? [text.data.text] : []
  })
  return texts.length ? texts.join('\n') : undefined
}

export class CodexChatProvider implements ChatProvider {
  readonly id = 'codex'
  readonly name = 'Codex'
  readonly defaultCommand = 'codex'

  constructor(
    private readonly command: readonly [string, ...string[]],
    private readonly directory = resolve(
      process.env.CODEX_HOME || join(homedir(), '.codex'),
    ),
  ) {}

  async install(): Promise<void> {
    await access(this.command[0])
    const args = [...this.command, this.id, 'codex']
    const handler = {
      type: 'command',
      command: [...args.map(quotePosixArgument), HOOK_MARKER].join(' '),
      ...(process.platform === 'win32'
        ? // PowerShell needs the call operator to invoke a quoted executable path.
          {
            commandWindows:
              '& ' +
              [...args.map(executePowerShell.escapeArgument), HOOK_MARKER].join(
                ' ',
              ),
          }
        : {}),
      timeout: 3,
    }
    await installHooks(
      join(this.directory, 'hooks.json'),
      Object.fromEntries(
        CODEX_CHAT_EVENTS.map((event) => [
          event,
          // Codex requires SessionEnd hooks to finish before closing the session.
          { hooks: [{ ...handler, async: event !== 'SessionEnd' }] },
        ]),
      ),
    )
  }

  async readReport(value: unknown): Promise<ChatReport> {
    const mtime = Date.now()
    const report = codexReportSchema.parse(value)
    const working = !(
      report.hook_event_name === 'Stop' ||
      report.hook_event_name === 'Interrupt' ||
      report.hook_event_name === 'SessionEnd' ||
      report.hook_event_name === 'PermissionRequest' ||
      (report.hook_event_name === 'SessionStart' && report.source !== 'compact')
    )
    const title = await this.readTitle(report.session_id)
    const chat: Chat = {
      providerId: this.id,
      sessionId: report.session_id,
      terminalId: report.terminalId,
      mtime,
      lastActivityAt:
        report.hook_event_name === 'UserPromptSubmit' ||
        report.hook_event_name === 'Stop' ||
        report.hook_event_name === 'Interrupt'
          ? mtime
          : undefined,
      title,
      description: report.prompt ?? report.last_assistant_message ?? undefined,
      worktreePath: report.worktreePath,
      pid: report.pid,
      status: working ? 'working' : 'idle',
    }
    return new CodexChatReport(chat, report.hook_event_name)
  }

  async listSessions(): Promise<ChatSession[]> {
    // Every unarchived thread a user started, including persisted exec runs.
    const rows = z
      .array(sessionSchema)
      .parse(
        this.queryThreads(
          "SELECT id, rollout_path, cwd, title, name, preview, first_user_message, history_mode FROM threads WHERE archived = 0 AND thread_source = 'user'",
        ),
      )
    let names: Promise<Map<string, string>> | undefined
    const sessions = await Promise.all(
      rows.map(async (row) => {
        // A thread without its rollout cannot be resumed.
        const rollout = await stat(row.rollout_path).catch(() => undefined)
        if (!rollout) return []
        return [
          {
            sessionId: row.id,
            title: await this.title(
              row,
              row.id,
              () => (names ??= this.indexedNames()),
            ),
            cwd: row.cwd,
            modifiedAt: Math.trunc(rollout.mtimeMs),
          },
        ]
      }),
    )
    return sessions.flat()
  }

  async *readMessages(
    sessionIds: readonly string[],
  ): AsyncGenerator<ChatMessage> {
    const rollouts = new Map(
      z
        .array(z.object({ id: z.string(), rollout_path: z.string() }))
        .parse(this.queryThreads('SELECT id, rollout_path FROM threads'))
        .map((row) => [row.id, row.rollout_path]),
    )
    for (const sessionId of sessionIds) {
      const path = rollouts.get(sessionId)
      if (!path) continue
      for await (const record of readJsonLines(path)) {
        const text = messageText(record)
        if (text !== undefined) yield { sessionId, text }
      }
    }
  }

  resumeCommand(command: string, sessionId: string): string {
    // Codex can otherwise return to the session's recorded directory (tui.resume_cwd).
    return `${command} resume --cd . ${sessionId}`
  }

  // Rows of Codex's thread metadata; none before Codex creates its database.
  private queryThreads(
    sql: string,
    ...parameters: SQLInputValue[]
  ): Record<string, SQLOutputValue>[] {
    const path = join(this.directory, 'state_5.sqlite')
    if (!existsSync(path)) return []
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      return database.prepare(sql).all(...parameters)
    } finally {
      database.close()
    }
  }

  private async readTitle(sessionId: string): Promise<string> {
    const [row] = this.queryThreads(
      'SELECT title, name, preview, first_user_message, history_mode FROM threads WHERE id = ?',
      sessionId,
    )
    return this.title(
      row === undefined ? undefined : metadataSchema.parse(row),
      sessionId,
      () => this.indexedNames(),
    )
  }

  // Matches the resume picker's saved-name / preview / empty-session ordering.
  private async title(
    row: z.infer<typeof metadataSchema> | undefined,
    sessionId: string,
    readNames: () => Promise<Map<string, string>>,
  ): Promise<string> {
    const description = (row?.preview || row?.first_user_message || '').trim()
    let name: string | undefined
    if (row?.history_mode === 'paginated') {
      name = row.name?.trim()
    } else {
      const title = row?.title.trim()
      name =
        title && title !== row?.first_user_message.trim()
          ? title
          : (await readNames()).get(sessionId)
    }
    return name || description || '(no message yet)'
  }

  // The latest non-empty saved name of each session in the legacy name index.
  private async indexedNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    for await (const record of readJsonLines(
      join(this.directory, 'session_index.jsonl'),
    )) {
      const entry = indexEntrySchema.safeParse(record)
      if (entry.success && entry.data.thread_name.trim())
        names.set(entry.data.id, entry.data.thread_name.trim())
    }
    return names
  }
}
