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
 * Claude Code hook events we subscribe to, mapped onto a chat status.
 *
 * Claude Code runs a configured shell command on each lifecycle event and pipes
 * the event JSON (including `hook_event_name`, `session_id`, `cwd`, …) on
 * stdin. We translate those events into the coarse busy/idle/dormant lifecycle:
 *   - prompt submitted / tool use  → the agent is working (`busy`)
 *   - finished / needs attention   → waiting for the user (`idle`)
 *   - session ended                → `dormant`
 *
 * `SubagentStop` is deliberately absent. A real Task subagent is already kept
 * `busy` by the surrounding tool's `PreToolUse`/`PostToolUse`, so mapping it
 * adds nothing there — but Claude Code's background away-summary ("recap")
 * generation also fires `SubagentStop` while the session is otherwise idle,
 * with no following `Stop`. Mapping it to `busy` would wrongly strand an idle
 * chat in `busy`.
 */
const HOOK_STATUS: Record<string, ChatStatus> = {
  UserPromptSubmit: CHAT_STATUS.busy,
  PreToolUse: CHAT_STATUS.busy,
  PostToolUse: CHAT_STATUS.busy,
  Notification: CHAT_STATUS.idle,
  Stop: CHAT_STATUS.idle,
  SessionEnd: CHAT_STATUS.dormant,
}

const HOOK_EVENTS = Object.keys(HOOK_STATUS)

/**
 * Events after which the description should be re-read from the transcript.
 * No hook payload carries the assistant's text, so we rescan the transcript
 * tail on every event that may have advanced the conversation: a fresh prompt
 * (`UserPromptSubmit`), mid-turn narration written before a tool call
 * (`PreToolUse`), a pause for input (`Notification`), or the final reply
 * (`Stop`). `PostToolUse` is omitted — it carries no new assistant text beyond
 * the matching `PreToolUse`.
 */
const HOOK_REFRESH_DESCRIPTION = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
])

// Read at most this many bytes from the end of a transcript when refreshing the
// live description; the latest entries we need sit at the very end of the file.
const TRANSCRIPT_TAIL_BYTES = 64 * 1024

export class ClaudeChatProvider implements ChatProvider {
  readonly id = CHAT_PROVIDER_ID.claude

  // Marker substring identifying a hook command we own, so re-configuring a
  // worktree replaces our group instead of stacking duplicates.
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
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    const settings = (await readJsonRecordFile(settingsPath)) ?? {}
    const hooks = upsertManagedHookGroups(
      settings.hooks,
      HOOK_EVENTS,
      () => this.hook(wrapperPath),
      (group) => this.isManagedGroup(group),
    )

    const next = { ...settings, hooks }
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.log.info({ settingsPath }, 'configured claude user chat hooks')
  }

  private async clearProjectHooks(worktreePath: string): Promise<void> {
    const settingsPath = join(worktreePath, '.claude', 'settings.local.json')
    const settings = await readJsonRecordFile(settingsPath)
    if (!settings) {
      return
    }

    const result = removeManagedHookGroups(settings.hooks, (group) =>
      this.isManagedGroup(group),
    )
    if (!result.changed) {
      return
    }

    const next = { ...settings }
    if (Object.keys(result.hooks).length > 0) {
      next.hooks = result.hooks
    } else {
      delete next.hooks
    }
    await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.log.info({ settingsPath }, 'cleared claude project chat hooks')
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

    return {
      chatId,
      status,
      // No payload carries the assistant's text, so the description is always
      // read from the transcript (see resolveDescription) rather than the event.
      refreshDescription: HOOK_REFRESH_DESCRIPTION.has(eventName),
      worktreeId: context.worktreeId,
    }
  }

  hookChatId(payload: Record<string, unknown>): string | undefined {
    // Claude Code's native session id is the chat's identity for us.
    return asString(payload.session_id)
  }

  /**
   * Read the transcript for a title (Claude Code's own AI-generated title, or
   * the first genuine user message) and a description (the latest assistant text
   * or prompt, whichever is most recent). This backfills details that live
   * events don't carry — in particular the description after a restart, when the
   * chat reappears via a status-only event rather than a fresh `UserPromptSubmit`.
   */
  resolveDetails(payload: Record<string, unknown>): Promise<ChatDetails> {
    return readTranscriptDetails(asString(payload.transcript_path))
  }

  resolveDescription(
    payload: Record<string, unknown>,
  ): Promise<string | undefined> {
    return readTranscriptTailDescription(asString(payload.transcript_path))
  }

  /**
   * Claude Code keeps one JSONL transcript per session under
   * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the directory
   * name is the worktree path with every non-alphanumeric character replaced by
   * `-` (the same scheme Claude Code uses). The session id is the file stem, and
   * is the chat id we expose.
   */
  async listHistory(worktree: WorktreeRef): Promise<HistoricalChat[]> {
    const dir = join(homedir(), '.claude', 'projects', encodeCwd(worktree.path))

    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      // No transcripts for this worktree yet.
      return []
    }

    const chats = await Promise.all(
      entries
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (name): Promise<HistoricalChat | null> => {
          const filePath = join(dir, name)
          try {
            const [info, details] = await Promise.all([
              stat(filePath),
              readTranscriptDetails(filePath),
            ])
            return {
              chatId: name.slice(0, -'.jsonl'.length),
              title: details.title,
              description: details.description,
              updatedAt: info.mtimeMs,
            }
          } catch {
            return null
          }
        }),
    )

    return chats
      .filter((chat): chat is HistoricalChat => chat !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  resumeLaunch(chatId: string): ChatLaunch {
    // Claude Code resumes by its native session id, which is our chat id.
    return { command: 'claude', args: ['--resume', chatId], chatId }
  }

  newLaunch(): ChatLaunch {
    return { command: 'claude', args: [] }
  }

  /**
   * A Claude Code command hook using the same managed forwarder as Codex.
   */
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

/**
 * Derive title and description from a Claude Code transcript JSONL file:
 *   - title:       Claude Code's own AI-generated title (`ai-title` entry), else
 *                  the first genuine user message.
 *   - description: the latest assistant text or genuine user prompt — whichever
 *                  comes last — describing what the chat is doing now. These
 *                  entries are appended in conversation order, so the last such
 *                  text we scan is the most recent.
 * Each field is `undefined` if the file is missing/unreadable or holds nothing
 * usable for it yet.
 */
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

  let aiTitle: string | undefined
  let firstUserMessage: string | undefined
  // Overwritten by each genuine user prompt and assistant text in file order,
  // so it ends on the most recent of the two — what the chat is doing now.
  let description: string | undefined
  for (const line of contents.split('\n')) {
    const entry = parseTranscriptLine(line)
    if (!entry) {
      continue
    }

    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
      // Keep scanning; the last ai-title in the file is the most recent.
      aiTitle = entry.aiTitle
      continue
    }
    const text = entryDescriptionText(entry)
    if (text) {
      if (entry.type === 'user') {
        firstUserMessage ??= text
      }
      description = text
    }
  }

  return {
    title: firstLine(aiTitle ?? firstUserMessage),
    description: firstLine(description),
  }
}

/**
 * Refresh just the live description by reading only the tail of the transcript:
 * the latest assistant text or genuine user prompt sits at the very end of the
 * file, so we avoid re-reading the whole thing on every hook. Returns
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
    // Reading from mid-file usually clips the first line into a fragment. Drop
    // it — we only want the most recent entry, which is at the end regardless.
    const clipped = start > 0
    if (clipped) {
      lines = lines.slice(1)
    }

    let description: string | undefined
    for (const line of lines) {
      const entry = parseTranscriptLine(line)
      if (entry) {
        description = entryDescriptionText(entry) ?? description
      }
    }

    if (description !== undefined || !clipped) {
      return firstLine(description)
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

/** Parse one transcript JSONL line into a record, or `undefined` if unusable. */
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

/**
 * The description-worthy text of a transcript entry: an assistant reply or a
 * genuine user prompt. `undefined` for anything else (titles, tool results, …).
 */
function entryDescriptionText(
  entry: Record<string, unknown>,
): string | undefined {
  if (entry.type === 'user') {
    return userMessageText(entry)
  }
  if (entry.type === 'assistant') {
    return assistantMessageText(entry)
  }
  return undefined
}

/**
 * Extract the plain-text reply from a transcript `assistant` entry, ignoring
 * thinking and tool-use blocks that aren't part of the visible answer.
 */
function assistantMessageText(
  entry: Record<string, unknown>,
): string | undefined {
  const message = isRecord(entry.message) ? entry.message : undefined
  const content = message?.content

  let text: string | undefined
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string'
      ) {
        parts.push(block.text)
      }
    }
    text = parts.join(' ')
  }

  text = text?.trim()
  return text ? text : undefined
}

/**
 * Extract the plain-text prompt from a transcript `user` entry, skipping tool
 * results and slash-command scaffolding that aren't real user prompts.
 */
function userMessageText(entry: Record<string, unknown>): string | undefined {
  const message = isRecord(entry.message) ? entry.message : undefined
  const content = message?.content

  let text: string | undefined
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (!isRecord(block)) {
        continue
      }
      // A tool result is delivered as a `user` entry but isn't a prompt.
      if (block.type === 'tool_result') {
        return undefined
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
    text = parts.join(' ')
  }

  text = text?.trim()
  if (!text || text.startsWith('<') || text.startsWith('Caveat:')) {
    // Empty, command scaffolding (`<command-name>…`), or an injected caveat.
    return undefined
  }
  return text
}

// Reduce a multi-line message to its first non-empty line. The full line is
// sent as-is; the client truncates for display via CSS ellipsis.
function firstLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const line = value.trim().split('\n', 1)[0].trim()
  return line || undefined
}

/**
 * Encode a working directory the way Claude Code names its project transcript
 * directory: every non-alphanumeric character becomes `-`. e.g.
 * `/Users/me/Workspace/ade-overlay` → `-Users-me-Workspace-ade-overlay`.
 */
function encodeCwd(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
