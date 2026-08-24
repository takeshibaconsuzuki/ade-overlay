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
import { pasteTextAndImagePaths } from '../../terminals/paste'
import {
  ensureHookForwarderWrapper,
  hookForwardCommand,
} from '../hookForwarder'
import { readJsonRecordFile } from './hookConfig'
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
 * Cursor uses lower-camel-case hook names in `~/.cursor/hooks.json`. A session
 * start is configured so a newly launched CLI can bind its conversation id to
 * the terminal immediately, but it deliberately has no status mapping: an
 * untouched session must not appear as a live chat.
 */
const HOOK_STATUS: Record<string, ChatStatus> = {
  beforeSubmitPrompt: CHAT_STATUS.busy,
  preToolUse: CHAT_STATUS.busy,
  postToolUse: CHAT_STATUS.busy,
  postToolUseFailure: CHAT_STATUS.busy,
  subagentStart: CHAT_STATUS.busy,
  subagentStop: CHAT_STATUS.busy,
  preCompact: CHAT_STATUS.busy,
  afterAgentThought: CHAT_STATUS.busy,
  afterAgentResponse: CHAT_STATUS.busy,
  stop: CHAT_STATUS.idle,
  sessionEnd: CHAT_STATUS.dormant,
}

const HOOK_EVENTS = ['sessionStart', ...Object.keys(HOOK_STATUS)]
const TRANSCRIPT_TAIL_BYTES = 64 * 1024

export class CursorChatProvider implements ChatProvider {
  readonly id = CHAT_PROVIDER_ID.cursor
  readonly terminalPaste = pasteTextAndImagePaths

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
    const hooksPath = join(cursorDataDir(), 'hooks.json')
    const config = (await readJsonRecordFile(hooksPath)) ?? {}
    const hooks = upsertCursorHooks(
      config.hooks,
      HOOK_EVENTS,
      this.hook(wrapperPath),
      (hook) => this.isManagedHook(hook),
    )

    await mkdir(dirname(hooksPath), { recursive: true })
    await writeFile(
      hooksPath,
      `${JSON.stringify({ ...config, version: config.version ?? 1, hooks }, null, 2)}\n`,
      'utf8',
    )
    this.log.info({ hooksPath }, 'configured cursor user chat hooks')
  }

  private async clearProjectHooks(worktreePath: string): Promise<void> {
    const hooksPath = join(worktreePath, '.cursor', 'hooks.json')
    const config = await readJsonRecordFile(hooksPath)
    if (!config) {
      return
    }

    const result = removeCursorHooks(config.hooks, (hook) =>
      this.isManagedHook(hook),
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
    this.log.info({ hooksPath }, 'cleared cursor project chat hooks')
  }

  hookChatId(payload: Record<string, unknown>): string | undefined {
    // Cursor calls this the conversation id in its common hook payload. Older
    // session lifecycle payloads also expose the same value as `session_id`.
    return asString(payload.conversation_id) ?? asString(payload.session_id)
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
      eventName === 'beforeSubmitPrompt'
        ? firstLine(asString(payload.prompt))
        : eventName === 'preToolUse'
          ? firstLine(asString(payload.agent_message))
          : eventName === 'afterAgentResponse'
            ? firstLine(asString(payload.text))
            : undefined

    return {
      chatId,
      status,
      description,
      refreshDescription: eventName === 'stop',
      worktreeId: context.worktreeId,
    }
  }

  resolveDetails(payload: Record<string, unknown>): Promise<ChatDetails> {
    return readTranscriptDetails(asStringOrNull(payload.transcript_path))
  }

  resolveDescription(
    payload: Record<string, unknown>,
  ): Promise<string | undefined> {
    return readTranscriptTailDescription(
      asStringOrNull(payload.transcript_path),
    )
  }

  /**
   * Cursor CLI stores chat metadata under `~/.cursor/chats/<store>/<chat-id>`.
   * Hook transcripts live in the cwd-keyed project directory. Metadata is the
   * authoritative cwd filter; the transcript supplies the latest visible text.
   */
  async listHistory(worktree: WorktreeRef): Promise<HistoricalChat[]> {
    const root = cursorDataDir()
    const metaFiles = await collectChatMetaFiles(join(root, 'chats'))
    const chats = await Promise.all(
      metaFiles.map(
        async ({ chatId, path }): Promise<HistoricalChat | null> => {
          try {
            const meta = await readJsonRecordFile(path)
            if (
              !meta ||
              asString(meta.cwd) !== worktree.path ||
              meta.hasConversation === false
            ) {
              return null
            }

            const transcriptPath = join(
              root,
              'projects',
              encodeCwd(worktree.path),
              'agent-transcripts',
              chatId,
              `${chatId}.jsonl`,
            )
            const [details, promptHistory, info] = await Promise.all([
              readTranscriptDetails(transcriptPath),
              readPromptHistory(join(dirname(path), 'prompt_history.json')),
              stat(path),
            ])
            const updatedAt = asFiniteNumber(meta.updatedAtMs) ?? info.mtimeMs

            return {
              chatId,
              title:
                firstLine(asString(meta.title)) ??
                details.title ??
                promptHistory.at(0),
              description: details.description ?? promptHistory.at(0),
              updatedAt,
            }
          } catch {
            return null
          }
        },
      ),
    )

    return chats
      .filter((chat): chat is HistoricalChat => chat !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  resumeLaunch(chatId: string): ChatLaunch {
    return { command: 'cursor-agent', args: ['--resume', chatId], chatId }
  }

  newLaunch(): ChatLaunch {
    return { command: 'cursor-agent', args: [] }
  }

  private hook(wrapperPath: string): {
    type: 'command'
    command: string
    timeout: number
  } {
    return hookForwardCommand(wrapperPath)
  }

  private isManagedHook(hook: unknown): boolean {
    return (
      isRecord(hook) &&
      typeof hook.command === 'string' &&
      (hook.command.includes(this.marker) ||
        hook.command.includes(this.wrapperMarker))
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

  let title: string | undefined
  let description: string | undefined
  for (const line of contents.split('\n')) {
    const message = cursorMessageText(parseTranscriptLine(line))
    if (!message) {
      continue
    }
    if (message.role === 'user') {
      title ??= message.text
    }
    description = message.text
  }
  return { title, description }
}

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
      description =
        cursorMessageText(parseTranscriptLine(line))?.text ?? description
    }
    if (description !== undefined || !clipped) {
      return description
    }
    return (await readTranscriptDetails(transcriptPath)).description
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

function cursorMessageText(
  entry: Record<string, unknown> | undefined,
): { role: 'user' | 'assistant'; text: string } | undefined {
  if (!entry || (entry.role !== 'user' && entry.role !== 'assistant')) {
    return undefined
  }
  const message = isRecord(entry.message) ? entry.message : undefined
  const text = contentText(message?.content)
  const line = firstLine(
    entry.role === 'user' ? userQueryText(text) ?? text : text,
  )
  return line ? { role: entry.role, text: line } : undefined
}

function userQueryText(value: string | undefined): string | undefined {
  return value?.match(/<user_query>([\s\S]*?)<\/user_query>/i)?.[1]
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return undefined
  }
  const parts = value
    .map((part) =>
      isRecord(part) && part.type === 'text' ? asString(part.text) : undefined,
    )
    .filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join('\n') : undefined
}

function parseTranscriptLine(
  line: string,
): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function collectChatMetaFiles(
  root: string,
): Promise<Array<{ chatId: string; path: string }>> {
  let stores
  try {
    stores = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const found = await Promise.all(
    stores
      .filter((entry) => entry.isDirectory())
      .map(async (store) => {
        let chats
        try {
          chats = await readdir(join(root, store.name), {
            withFileTypes: true,
          })
        } catch {
          return []
        }
        return chats
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({
            chatId: entry.name,
            path: join(root, store.name, entry.name, 'meta.json'),
          }))
      }),
  )
  return found.flat()
}

async function readPromptHistory(path: string): Promise<string[]> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => firstLine(asString(entry)))
    .filter((entry): entry is string => entry !== undefined)
}

function upsertCursorHooks(
  hooksValue: unknown,
  events: readonly string[],
  hook: unknown,
  isManaged: (hook: unknown) => boolean,
): Record<string, unknown> {
  const hooks = isRecord(hooksValue) ? { ...hooksValue } : {}
  for (const event of events) {
    const existing = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[])
      : []
    hooks[event] = [...existing.filter((entry) => !isManaged(entry)), hook]
  }
  return hooks
}

function removeCursorHooks(
  hooksValue: unknown,
  isManaged: (hook: unknown) => boolean,
): { hooks: Record<string, unknown>; changed: boolean } {
  if (!isRecord(hooksValue)) {
    return { hooks: {}, changed: false }
  }
  let changed = false
  const hooks: Record<string, unknown> = {}
  for (const [event, value] of Object.entries(hooksValue)) {
    if (!Array.isArray(value)) {
      hooks[event] = value
      continue
    }
    const preserved = value.filter((entry) => !isManaged(entry))
    changed ||= preserved.length !== value.length
    if (preserved.length > 0) {
      hooks[event] = preserved
    }
  }
  return { hooks, changed }
}

function cursorDataDir(): string {
  const configured = process.env.CURSOR_CONFIG_DIR
  return configured && configured.length > 0
    ? configured
    : join(homedir(), '.cursor')
}

function encodeCwd(path: string): string {
  return path.replace(/^[\\/]+/, '').replaceAll(/[^a-zA-Z0-9]/g, '-')
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

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
