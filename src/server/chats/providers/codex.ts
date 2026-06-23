import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
  type FileHandle,
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
  readJsonRecordFile,
  removeManagedHookGroups,
  upsertManagedHookGroups,
} from './hookConfig'
import {
  type ChatDetails,
  type ChatHookContext,
  type ChatLaunch,
  type ChatProvider,
  type ChatStatusUpdate,
  type HistoricalChat,
  type WorktreeRef,
} from './types'

/**
 * Codex lifecycle hooks are command hooks in `~/.codex/hooks.json`. Each
 * command receives one event JSON object on stdin, which we forward to ADE
 * Overlay's local hook sink.
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

/**
 * Codex hook payloads only carry the latest prompt, not assistant text. Re-read
 * the transcript after events that may have appended a visible assistant update
 * so the live description follows the conversation instead of staying pinned to
 * the last prompt.
 */
const HOOK_REFRESH_DESCRIPTION = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'Stop',
])

// Read at most this many bytes from the end of a transcript when refreshing the
// live description; the latest entries we need sit at the very end of the file.
const TRANSCRIPT_TAIL_BYTES = 64 * 1024

export class CodexChatProvider implements ChatProvider {
  readonly id = CHAT_PROVIDER_ID.codex

  private readonly marker = `${CHAT_HOOKS_PATH}/${this.id}`
  private readonly wrapperMarker = `ade-overlay-chat-hook-${this.id}`

  constructor(private readonly log: Logger) {}

  async configureWorktree(worktree: WorktreeRef): Promise<void> {
    const hookEndpoint = new URL(`${SERVER_ORIGIN}${this.marker}`)
    const wrapperPath = await ensureHookForwarderWrapper(
      this.id,
      hookEndpoint.toString(),
    )
    await this.configureUserHooks(wrapperPath)
    await this.clearProjectHooks(worktree.path)
  }

  private async configureUserHooks(wrapperPath: string): Promise<void> {
    const hooksPath = join(homedir(), '.codex', 'hooks.json')
    const config = (await readJsonRecordFile(hooksPath)) ?? {}
    const hooks = upsertManagedHookGroups(
      config.hooks,
      HOOK_EVENTS,
      () => this.hook(wrapperPath),
      (group) => this.isManagedGroup(group),
    )

    const next = { ...config, hooks }
    await mkdir(dirname(hooksPath), { recursive: true })
    await writeFile(hooksPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.log.info({ hooksPath }, 'configured codex user chat hooks')
  }

  private async clearProjectHooks(worktreePath: string): Promise<void> {
    const hooksPath = join(worktreePath, '.codex', 'hooks.json')
    const config = await readJsonRecordFile(hooksPath)
    if (!config) {
      return
    }

    const result = removeManagedHookGroups(config.hooks, (group) =>
      this.isManagedGroup(group),
    )
    if (!result.changed) {
      return
    }

    const next = { ...config }
    if (Object.keys(result.hooks).length > 0) {
      next.hooks = result.hooks
    } else {
      delete next.hooks
    }
    await writeFile(hooksPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.log.info({ hooksPath }, 'cleared codex project chat hooks')
  }

  mapHook(
    payload: Record<string, unknown>,
    context: ChatHookContext,
  ): ChatStatusUpdate | null {
    const eventName = asString(payload.hook_event_name)
    const chatId = this.hookChatId(payload)
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
      refreshDescription: HOOK_REFRESH_DESCRIPTION.has(eventName),
      worktreeId: context.worktreeId,
    }
  }

  hookChatId(payload: Record<string, unknown>): string | undefined {
    // Codex's native session id is the chat's identity for us.
    return asString(payload.session_id)
  }

  resolveDetails(payload: Record<string, unknown>): Promise<ChatDetails> {
    return readTranscriptDetails(asStringOrNull(payload.transcript_path))
  }

  async resolveDescription(
    payload: Record<string, unknown>,
  ): Promise<string | undefined> {
    return readTranscriptTailDescription(
      asStringOrNull(payload.transcript_path),
    )
  }

  /**
   * Codex stores one rollout transcript per session under
   * `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`. Each file's first
   * line is a `session_meta` record carrying the session `id` and the `cwd` it
   * ran in. We read only that head line to attribute a session to a worktree,
   * then read matched files in full for details and use file mtimes for sorting.
   * The session id is the chat id we expose.
   */
  async listHistory(worktree: WorktreeRef): Promise<HistoricalChat[]> {
    const root = join(homedir(), '.codex', 'sessions')

    let files: string[]
    try {
      files = await collectJsonlFiles(root)
    } catch {
      return []
    }

    const metas = await Promise.all(
      files.map(async (filePath): Promise<HistoricalChat | null> => {
        const meta = await readSessionMeta(filePath)
        if (!meta || meta.cwd !== worktree.path) {
          return null
        }
        const [details, info] = await Promise.all([
          readTranscriptDetails(filePath),
          stat(filePath),
        ])
        return {
          chatId: meta.id,
          title: details.title,
          description: details.description,
          updatedAt: info.mtimeMs,
        }
      }),
    )

    return metas
      .filter((chat): chat is HistoricalChat => chat !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  resumeLaunch(chatId: string): ChatLaunch {
    // Codex resumes by its native session id, which is our chat id.
    return { command: 'codex', args: ['resume', chatId], chatId }
  }

  newLaunch(): ChatLaunch {
    return { command: 'codex', args: [] }
  }

  private hook(wrapperPath: string): {
    type: 'command'
    command: string
    timeout: number
  } {
    return hookForwardCommand(wrapperPath)
  }

  private isManagedGroup(group: unknown): boolean {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      return false
    }
    return group.hooks.some(
      (hook) =>
        isRecord(hook) &&
        ((hook.type === 'http' &&
          typeof hook.url === 'string' &&
          hook.url.includes(this.marker)) ||
          (hook.type === 'command' &&
            typeof hook.command === 'string' &&
            (hook.command.includes(this.marker) ||
              hook.command.includes(this.wrapperMarker)))),
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
  let description: string | undefined
  let firstFallbackUserMessage: string | undefined
  for (const line of contents.split('\n')) {
    const entry = parseTranscriptLine(line)
    if (!entry) {
      continue
    }

    const text = codexEventUserMessageText(entry)
    if (text) {
      firstUserMessage ??= text
      description = text
      continue
    }

    const agentText = codexEventAgentMessageText(entry)
    if (agentText) {
      description = agentText
      continue
    }

    const fallbackText = codexResponseUserMessageText(entry)
    if (fallbackText) {
      firstFallbackUserMessage ??= fallbackText
      description = fallbackText
      continue
    }

    const fallbackAgentText = codexResponseAssistantMessageText(entry)
    if (fallbackAgentText) {
      description = fallbackAgentText
    }
  }

  return {
    title: firstUserMessage ?? firstFallbackUserMessage,
    description,
  }
}

/**
 * Refresh just the live description by reading only the tail of the transcript:
 * the latest visible assistant text or genuine user prompt sits near the end of
 * the file, so we avoid re-reading the whole session on every hook. Returns
 * `undefined` when the file is missing/unreadable or holds nothing usable.
 */
async function readTranscriptTailDescription(
  transcriptPath: string | undefined,
): Promise<string | undefined> {
  if (!transcriptPath) {
    return undefined
  }

  let handle: FileHandle | undefined
  try {
    handle = await open(transcriptPath, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
    const length = size - start
    if (length === 0) {
      return undefined
    }

    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    let lines = buffer.toString('utf8', 0, bytesRead).split('\n')
    const clipped = start > 0
    if (clipped) {
      lines = lines.slice(1)
    }

    let description: string | undefined
    for (const line of lines) {
      const entry = parseTranscriptLine(line)
      if (!entry) {
        continue
      }
      description =
        codexEventDescriptionText(entry) ??
        codexResponseDescriptionText(entry) ??
        description
    }

    if (description !== undefined) {
      return description
    }
    if (!clipped) {
      return undefined
    }
    // The tail held no usable text and may have clipped the entry we need (e.g.
    // a final message longer than the tail window); fall back to a full read.
    return (await readTranscriptDetails(transcriptPath)).description
  } catch {
    return undefined
  } finally {
    await handle?.close()
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

function parseTranscriptLine(
  line: string,
): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed) {
    return undefined
  }

  let entry: unknown
  try {
    entry = JSON.parse(trimmed)
  } catch {
    return undefined
  }

  return isRecord(entry) ? entry : undefined
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

function codexEventAgentMessageText(
  entry: Record<string, unknown>,
): string | undefined {
  if (entry.type === 'event_msg') {
    const payload = isRecord(entry.payload) ? entry.payload : undefined
    if (payload?.type === 'agent_message') {
      return firstLine(asString(payload.message))
    }
  }

  return undefined
}

function codexEventDescriptionText(
  entry: Record<string, unknown>,
): string | undefined {
  return codexEventUserMessageText(entry) ?? codexEventAgentMessageText(entry)
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

function codexResponseAssistantMessageText(
  entry: Record<string, unknown>,
): string | undefined {
  if (entry.type === 'response_item') {
    const payload = isRecord(entry.payload) ? entry.payload : undefined
    if (payload?.type === 'message' && payload.role === 'assistant') {
      return firstLine(contentText(payload.content))
    }
  }

  return undefined
}

function codexResponseDescriptionText(
  entry: Record<string, unknown>,
): string | undefined {
  return (
    codexResponseUserMessageText(entry) ??
    codexResponseAssistantMessageText(entry)
  )
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
