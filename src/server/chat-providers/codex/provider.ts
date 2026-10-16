import { existsSync, createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { executePowerShell } from 'powershell-utils'
import { z } from 'zod'
import { quotePosixArgument } from '../../../shared/shell'
import type { Chat } from '../../../shared/api'
import type { ChatProvider, ChatReport } from '../../chat-provider'
import { findWorktreeRoot } from '../../git-utils'
import { HOOK_MARKER, installHooks } from '../hooks-file'
import { CODEX_CHAT_EVENTS, CodexChatReport, codexReportSchema } from './report'

const metadataSchema = z.object({
  title: z.string(),
  name: z.string().nullable(),
  preview: z.string(),
  first_user_message: z.string(),
  history_mode: z.enum(['legacy', 'paginated']),
})

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
    const [title, worktreePath] = await Promise.all([
      this.readTitle(report.session_id),
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
        report.hook_event_name === 'Interrupt'
          ? mtime
          : undefined,
      title,
      description: report.prompt ?? report.last_assistant_message ?? undefined,
      worktreePath,
      pid: report.pid,
      status: working ? 'working' : 'idle',
    }
    return new CodexChatReport(chat, report.hook_event_name)
  }

  private async readTitle(sessionId: string): Promise<string> {
    const path = join(this.directory, 'state_5.sqlite')
    let row: z.infer<typeof metadataSchema> | undefined
    if (existsSync(path)) {
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        const value = database
          .prepare(
            'SELECT title, name, preview, first_user_message, history_mode FROM threads WHERE id = ?',
          )
          .get(sessionId)
        if (value) row = metadataSchema.parse(value)
      } finally {
        database.close()
      }
    }
    const description = (row?.preview || row?.first_user_message || '').trim()
    let name: string | undefined
    if (row?.history_mode === 'paginated') {
      name = row.name?.trim()
    } else {
      const title = row?.title.trim()
      name =
        title && title !== row?.first_user_message.trim()
          ? title
          : await this.indexedName(sessionId)
    }
    // Match the resume picker's saved-name / preview / empty-session ordering.
    return name || description || '(no message yet)'
  }

  private async indexedName(sessionId: string): Promise<string | undefined> {
    const path = join(this.directory, 'session_index.jsonl')
    if (!existsSync(path)) return undefined
    const input = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    let name: string | undefined
    try {
      for await (const line of lines) {
        try {
          const entry = z
            .object({ id: z.string(), thread_name: z.string() })
            .parse(JSON.parse(line))
          if (entry.id === sessionId && entry.thread_name.trim())
            name = entry.thread_name.trim()
        } catch {
          // An append in progress may leave an incomplete final line.
        }
      }
    } finally {
      lines.close()
      input.destroy()
    }
    return name
  }
}
