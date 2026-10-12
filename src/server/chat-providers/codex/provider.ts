import { existsSync, createReadStream } from 'node:fs'
import { access, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { executePowerShell } from 'powershell-utils'
import lockfile from 'proper-lockfile'
import { simpleGit } from 'simple-git'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import type { Chat } from '../../../shared/api'
import { quotePosixArgument } from '../../../shared/shell'
import type { ChatProvider } from '../../chat-provider'
import { CODEX_CHAT_EVENTS, codexReportSchema } from './report'

const marker = ' --ade-overlay'
const hooksSchema = z.looseObject({
  hooks: z
    .record(
      z.string(),
      z.array(
        z.looseObject({
          hooks: z.array(
            z.looseObject({ type: z.string(), command: z.string().optional() }),
          ),
        }),
      ),
    )
    .optional(),
})

const metadataSchema = z.object({
  title: z.string(),
  name: z.string().nullable(),
  preview: z.string(),
  first_user_message: z.string(),
  history_mode: z.enum(['legacy', 'paginated']),
})

export class CodexChatProvider implements ChatProvider {
  readonly id = 'codex'

  constructor(
    private readonly entrypoint: string,
    private readonly directory = resolve(
      process.env.CODEX_HOME || join(homedir(), '.codex'),
    ),
  ) {}

  async install(): Promise<void> {
    const entrypoint = resolve(this.entrypoint)
    await access(entrypoint)
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, 'hooks.json')
    const release = await lockfile.lock(path, {
      realpath: false,
      retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    })
    try {
      let content = '{}'
      try {
        content = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // Invalid user configuration is never overwritten.
      const document = hooksSchema.parse(JSON.parse(content))
      const hooks = (document.hooks ??= {})
      for (const [event, groups] of Object.entries(hooks)) {
        hooks[event] = groups.flatMap((group) => {
          const remaining = group.hooks.filter(
            (hook) =>
              !(hook.type === 'command' && hook.command?.endsWith(marker)),
          )
          return remaining.length === group.hooks.length
            ? [group]
            : remaining.length
              ? [{ ...group, hooks: remaining }]
              : []
        })
      }
      const args = [process.execPath, entrypoint, this.id, 'codex']
      const handler = {
        type: 'command',
        command: args.map(quotePosixArgument).join(' ') + marker,
        ...(process.platform === 'win32'
          ? // PowerShell needs the call operator to invoke a quoted executable path.
            {
              commandWindows:
                '& ' +
                args.map(executePowerShell.escapeArgument).join(' ') +
                marker,
            }
          : {}),
        timeout: 3,
      }
      // Accepted tradeoff: asynchronous reporting keeps Codex responsive, but reports
      // can arrive out of source-event order and leave status stale until another report.
      // The server applies receipt order; reporter timestamps cannot guarantee source order.
      for (const event of CODEX_CHAT_EVENTS) {
        // Codex requires SessionEnd hooks to finish before closing the session.
        ;(hooks[event] ??= []).push({
          hooks: [{ ...handler, async: event !== 'SessionEnd' }],
        })
      }
      const next = JSON.stringify(document, null, 2) + '\n'
      if (next !== content)
        await writeFileAtomic(path, next, { encoding: 'utf8' })
    } finally {
      await release()
    }
  }

  async readReport(value: unknown): Promise<Chat> {
    const mtime = Date.now()
    const report = codexReportSchema.parse(value)
    const [title, worktreePath] = await Promise.all([
      this.readTitle(report.session_id),
      // TODO: Use an environment variable supplied by ADE for the worktree path.
      simpleGit(report.cwd)
        .revparse(['--show-toplevel'])
        .then((path) => resolve(path.trim()))
        .catch(() => resolve(report.cwd)),
    ])
    return {
      providerId: this.id,
      sessionId: report.session_id,
      mtime,
      title,
      description: report.prompt ?? report.last_assistant_message ?? undefined,
      worktreePath,
      pid: report.pid,
      status:
        report.hook_event_name === 'UserPromptSubmit' ||
        (report.hook_event_name === 'SessionStart' &&
          report.source === 'compact')
          ? 'working'
          : 'idle',
    }
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
