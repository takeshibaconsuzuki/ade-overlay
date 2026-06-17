import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CHAT_HOOKS_PATH,
  CHAT_PROVIDER,
  CHAT_STATUS,
  type ChatStatus,
} from '../../../api/server/chats'
import { SERVER_ORIGIN } from '../../../api/server/config'
import { type Logger } from '../../../api/server/logger'
import {
  type ChatDetails,
  type ChatHookContext,
  type ChatLaunch,
  type ChatProvider,
  type ChatSessionSummary,
  type ChatStatusUpdate,
  type WorktreeRef,
} from './types'

/**
 * Codex lifecycle hooks are command hooks in `.codex/hooks.json`. Each command
 * receives one event JSON object on stdin, which we forward to ADE Overlay's
 * local hook sink.
 */
const HOOK_STATUS: Record<string, ChatStatus> = {
  SessionStart: CHAT_STATUS.idle,
  UserPromptSubmit: CHAT_STATUS.busy,
  PreToolUse: CHAT_STATUS.busy,
  PermissionRequest: CHAT_STATUS.idle,
  PostToolUse: CHAT_STATUS.busy,
  PreCompact: CHAT_STATUS.busy,
  PostCompact: CHAT_STATUS.busy,
  SubagentStart: CHAT_STATUS.busy,
  SubagentStop: CHAT_STATUS.busy,
  Stop: CHAT_STATUS.idle,
}

const HOOK_EVENTS = Object.keys(HOOK_STATUS)

export class CodexChatProvider implements ChatProvider {
  readonly id = CHAT_PROVIDER.codex

  private readonly marker = `${CHAT_HOOKS_PATH}/${this.id}`

  constructor(private readonly log: Logger) {}

  async configureWorktree(worktree: WorktreeRef): Promise<void> {
    const hooksPath = join(worktree.path, '.codex', 'hooks.json')

    let config: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await readFile(hooksPath, 'utf8')) as unknown
      if (isRecord(parsed)) {
        config = parsed
      }
    } catch {
      // No (or unreadable) existing hooks file -- start from an empty object.
    }

    const hooks = isRecord(config.hooks) ? { ...config.hooks } : {}
    for (const event of HOOK_EVENTS) {
      const existing = Array.isArray(hooks[event])
        ? (hooks[event] as unknown[])
        : []
      const preserved = existing.filter((group) => !this.isManagedGroup(group))
      hooks[event] = [...preserved, { hooks: [this.hook(worktree.worktreeId)] }]
    }

    const next = { ...config, hooks }
    await mkdir(dirname(hooksPath), { recursive: true })
    await writeFile(hooksPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.log.info({ hooksPath }, 'configured codex chat hooks')
  }

  mapHook(
    payload: Record<string, unknown>,
    context: ChatHookContext,
  ): ChatStatusUpdate | null {
    const eventName = asString(payload.hook_event_name)
    const chatId = asString(payload.session_id)
    if (!eventName || !chatId) {
      return null
    }

    const status = HOOK_STATUS[eventName]
    if (!status) {
      return null
    }

    const description =
      eventName === 'UserPromptSubmit'
        ? firstLine(asString(payload.prompt))
        : undefined

    return {
      chatId,
      status,
      description,
      worktreeId: context.worktreeId,
    }
  }

  resolveDetails(payload: Record<string, unknown>): Promise<ChatDetails> {
    return readTranscriptDetails(asStringOrNull(payload.transcript_path))
  }

  /**
   * Codex stores one rollout transcript per session under
   * `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`. Each file's first
   * line is a `session_meta` record carrying the session `id` and the `cwd` it
   * ran in. We read only that head line to attribute a session to a worktree,
   * then read the matched files in full for a title.
   */
  async listSessions(worktree: WorktreeRef): Promise<ChatSessionSummary[]> {
    const root = join(homedir(), '.codex', 'sessions')

    let files: string[]
    try {
      files = await collectJsonlFiles(root)
    } catch {
      return []
    }

    const metas = await Promise.all(
      files.map(async (filePath): Promise<ChatSessionSummary | null> => {
        const meta = await readSessionMeta(filePath)
        if (!meta || meta.cwd !== worktree.path) {
          return null
        }
        const details = await readTranscriptDetails(filePath)
        return {
          sessionId: meta.id,
          title: details.title,
          updatedAt: meta.updatedAt,
        }
      }),
    )

    return metas
      .filter((session): session is ChatSessionSummary => session !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  resumeLaunch(sessionId: string): ChatLaunch {
    return { command: 'codex', args: ['resume', sessionId], sessionId }
  }

  newLaunch(): ChatLaunch {
    return { command: 'codex', args: [] }
  }

  private hook(worktreeId: string): {
    type: 'command'
    command: string
    timeout: number
  } {
    const url = new URL(`${SERVER_ORIGIN}${this.marker}`)
    url.searchParams.set('worktreeId', worktreeId)
    const script = [
      'import sys,urllib.request',
      'data=sys.stdin.buffer.read()',
      'req=urllib.request.Request(sys.argv[1],data=data,headers={"Content-Type":"application/json"},method="POST")',
      'urllib.request.urlopen(req,timeout=1).read()',
    ].join(';')

    return {
      type: 'command',
      command: `/usr/bin/env python3 -c ${shellQuote(script)} ${shellQuote(url.toString())} >/dev/null 2>&1 || true`,
      timeout: 5,
    }
  }

  private isManagedGroup(group: unknown): boolean {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      return false
    }
    return group.hooks.some(
      (hook) =>
        isRecord(hook) &&
        hook.type === 'command' &&
        typeof hook.command === 'string' &&
        hook.command.includes(this.marker),
    )
  }
}

async function readTranscriptDetails(
  transcriptPath: string | undefined,
): Promise<ChatDetails> {
  if (!transcriptPath) {
    return {}
  }

  let contents: string
  try {
    contents = await readFile(transcriptPath, 'utf8')
  } catch {
    return {}
  }

  let firstUserMessage: string | undefined
  let lastUserMessage: string | undefined
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(entry) || entry.type !== 'event_msg') {
      continue
    }

    const payload = isRecord(entry.payload) ? entry.payload : undefined
    if (payload?.type !== 'user_message') {
      continue
    }

    const text = firstLine(asString(payload.message))
    if (text) {
      firstUserMessage ??= text
      lastUserMessage = text
    }
  }

  return {
    title: firstUserMessage,
    description: lastUserMessage,
  }
}

/** Recursively collect every `.jsonl` rollout file under a directory. */
async function collectJsonlFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(path)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          found.push(path)
        }
      }),
    )
  }
  await walk(root)
  return found
}

/**
 * Read just the first line of a rollout file and parse its `session_meta`.
 * Returns the session id, the cwd it ran in, and a sort timestamp (epoch ms).
 */
async function readSessionMeta(
  filePath: string,
): Promise<{ id: string; cwd: string; updatedAt: number } | null> {
  let head: string
  try {
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(16_384)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      head = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }

  const firstLineText = head.split('\n', 1)[0]
  let entry: unknown
  try {
    entry = JSON.parse(firstLineText)
  } catch {
    return null
  }

  if (!isRecord(entry) || entry.type !== 'session_meta') {
    return null
  }
  const payload = isRecord(entry.payload) ? entry.payload : undefined
  const id = asString(payload?.id)
  const cwd = asString(payload?.cwd)
  if (!id || !cwd) {
    return null
  }

  const timestamp = asString(payload?.timestamp ?? entry.timestamp)
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN
  return { id, cwd, updatedAt: Number.isNaN(parsed) ? 0 : parsed }
}

function firstLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const line = value.trim().split('\n', 1)[0].trim()
  return line || undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asStringOrNull(value: unknown): string | undefined {
  return typeof value === 'string' ? asString(value) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
