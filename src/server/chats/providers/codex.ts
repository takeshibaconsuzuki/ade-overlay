import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CHAT_HOOKS_PATH,
  CHAT_PROVIDER_ID,
  CHAT_STATUS,
  type ChatStatus,
} from '../../../api/server/chats'
import { SERVER_ORIGIN } from '../../../api/server/config'
import { type Logger } from '../../../api/server/logger'
import {
  ensureHookForwarderWrapper,
  hookForwardCommand,
} from '../hookForwarder'
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
  readonly id = CHAT_PROVIDER_ID.codex

  private readonly marker = `${CHAT_HOOKS_PATH}/${this.id}`
  private readonly wrapperMarker = `ade-overlay-chat-hook-${this.id}`

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

    const hookEndpoint = new URL(`${SERVER_ORIGIN}${this.marker}`)
    const wrapperPath = await ensureHookForwarderWrapper(
      this.id,
      hookEndpoint.toString(),
    )
    const hooks = isRecord(config.hooks) ? { ...config.hooks } : {}
    for (const event of HOOK_EVENTS) {
      const existing = Array.isArray(hooks[event])
        ? (hooks[event] as unknown[])
        : []
      const preserved = existing.filter((group) => !this.isManagedGroup(group))
      hooks[event] = [
        ...preserved,
        { hooks: [this.hook(worktree.worktreeId, wrapperPath)] },
      ]
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
    const chatId = this.hookSessionId(payload)
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

  hookSessionId(payload: Record<string, unknown>): string | undefined {
    return asString(payload.session_id)
  }

  resolveDetails(payload: Record<string, unknown>): Promise<ChatDetails> {
    return readTranscriptDetails(asStringOrNull(payload.transcript_path))
  }

  // Codex hooks already carry the description live, so they never request a
  // refresh; this satisfies the provider contract and stays correct if they do.
  async resolveDescription(
    payload: Record<string, unknown>,
  ): Promise<string | undefined> {
    return (await this.resolveDetails(payload)).description
  }

  /**
   * Codex stores one rollout transcript per session under
   * `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`. Each file's first
   * line is a `session_meta` record carrying the session `id` and the `cwd` it
   * ran in. We read only that head line to attribute a session to a worktree,
   * then read matched files in full for titles and use file mtimes for sorting.
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
        const [details, info] = await Promise.all([
          readTranscriptDetails(filePath),
          stat(filePath),
        ])
        return {
          sessionId: meta.id,
          title: details.title,
          description: details.description,
          updatedAt: info.mtimeMs,
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

  private hook(
    worktreeId: string,
    wrapperPath: string,
  ): {
    type: 'command'
    command: string
    timeout: number
  } {
    return hookForwardCommand(wrapperPath, worktreeId)
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
        (hook.command.includes(this.marker) ||
          hook.command.includes(this.wrapperMarker)),
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
  let firstFallbackUserMessage: string | undefined
  let lastFallbackUserMessage: string | undefined
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
    if (!isRecord(entry)) {
      continue
    }

    const text = codexEventUserMessageText(entry)
    if (text) {
      firstUserMessage ??= text
      lastUserMessage = text
      continue
    }

    const fallbackText = codexResponseUserMessageText(entry)
    if (fallbackText) {
      firstFallbackUserMessage ??= fallbackText
      lastFallbackUserMessage = fallbackText
    }
  }

  return {
    title: firstUserMessage ?? firstFallbackUserMessage,
    description: lastUserMessage ?? lastFallbackUserMessage,
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
 * Returns the session id and the cwd it ran in.
 */
async function readSessionMeta(
  filePath: string,
): Promise<{ id: string; cwd: string } | null> {
  const firstLineText = await readFirstLine(filePath)
  if (!firstLineText) {
    return null
  }

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

  return { id, cwd }
}

async function readFirstLine(filePath: string): Promise<string | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return null
  }

  try {
    const chunks: string[] = []
    const buffer = Buffer.alloc(64 * 1024)
    let position = 0

    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      )
      if (bytesRead === 0) {
        return chunks.length > 0 ? chunks.join('') : null
      }

      const chunk = buffer.toString('utf8', 0, bytesRead)
      const newline = chunk.indexOf('\n')
      if (newline !== -1) {
        chunks.push(chunk.slice(0, newline))
        return chunks.join('')
      }

      chunks.push(chunk)
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
}

function codexEventUserMessageText(
  entry: Record<string, unknown>,
): string | undefined {
  if (entry.type === 'event_msg') {
    const payload = isRecord(entry.payload) ? entry.payload : undefined
    if (payload?.type === 'user_message') {
      return firstLine(asString(payload.message))
    }
  }

  return undefined
}

function codexResponseUserMessageText(
  entry: Record<string, unknown>,
): string | undefined {
  if (entry.type === 'response_item') {
    const payload = isRecord(entry.payload) ? entry.payload : undefined
    if (payload?.type === 'message' && payload.role === 'user') {
      return userPromptLine(contentText(payload.content))
    }
  }

  return undefined
}

function userPromptLine(value: string | undefined): string | undefined {
  const line = firstLine(value)
  if (
    !line ||
    line.startsWith('<turn_aborted>') ||
    line.startsWith('# AGENTS.md')
  ) {
    return undefined
  }
  return line
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return undefined
  }

  const parts = value
    .map((part) => {
      if (!isRecord(part)) {
        return undefined
      }
      return asString(part.text)
    })
    .filter((part): part is string => part !== undefined)

  return parts.length > 0 ? parts.join('\n') : undefined
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
