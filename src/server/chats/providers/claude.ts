import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  type ChatProvider,
  type ChatStatusUpdate,
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
  SessionStart: CHAT_STATUS.idle,
  UserPromptSubmit: CHAT_STATUS.busy,
  PreToolUse: CHAT_STATUS.busy,
  PostToolUse: CHAT_STATUS.busy,
  Notification: CHAT_STATUS.idle,
  Stop: CHAT_STATUS.idle,
  SessionEnd: CHAT_STATUS.dormant,
}

const HOOK_EVENTS = Object.keys(HOOK_STATUS)

export class ClaudeChatProvider implements ChatProvider {
  readonly id = CHAT_PROVIDER.claude

  // Marker substring identifying a hook command we own, so re-configuring a
  // worktree replaces our group instead of stacking duplicates.
  private readonly marker = `${CHAT_HOOKS_PATH}/${this.id}`

  constructor(private readonly log: Logger) {}

  async configureWorktree(worktree: WorktreeRef): Promise<void> {
    // `settings.local.json` is the machine-local, git-ignored settings file
    // Claude Code merges at runtime — writing here keeps the worktree's tracked
    // `settings.json` untouched.
    const settingsPath = join(worktree.path, '.claude', 'settings.local.json')

    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<
        string,
        unknown
      >
    } catch {
      // No (or unreadable) existing settings — start from an empty object.
    }

    const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {}
    for (const event of HOOK_EVENTS) {
      const existing = Array.isArray(hooks[event])
        ? (hooks[event] as unknown[])
        : []
      // Drop any prior group we added, then append a fresh one. This preserves
      // the user's own hooks while keeping ours idempotent.
      const preserved = existing.filter((group) => !this.isManagedGroup(group))
      hooks[event] = [...preserved, { hooks: [this.hook(worktree.worktreeId)] }]
    }

    const next = { ...settings, hooks }
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.log.info({ settingsPath }, 'configured claude chat hooks')
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

    // A live prompt updates the description immediately; the transcript
    // fallback (see resolveDetails) backfills it when no live event carries it.
    const description =
      eventName === 'UserPromptSubmit'
        ? firstLine(asString(payload.prompt))
        : undefined

    return {
      chatId,
      status,
      description,
      // Authoritative worktree identity from the hook URL we configured.
      worktreeId: context.worktreeId,
    }
  }

  /**
   * Read the transcript for a title (Claude Code's own conversation summary, or
   * the first genuine user message) and a description (the latest genuine user
   * message). This backfills details that live events don't carry — in
   * particular the description after a restart, when the chat reappears via a
   * status-only event rather than a fresh `UserPromptSubmit`.
   */
  resolveDetails(payload: Record<string, unknown>): Promise<ChatDetails> {
    return readTranscriptDetails(asString(payload.transcript_path))
  }

  /**
   * A Claude Code `http` hook: it POSTs the event JSON straight to our endpoint,
   * so no shell or `curl` is involved (works the same on every platform). The
   * worktree id is carried as a query param so we can attribute the call to a
   * worktree without trusting the payload's reported cwd.
   */
  private hook(worktreeId: string): { type: 'http'; url: string } {
    const url = new URL(`${SERVER_ORIGIN}${this.marker}`)
    url.searchParams.set('worktreeId', worktreeId)
    return { type: 'http', url: url.toString() }
  }

  private isManagedGroup(group: unknown): boolean {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      return false
    }
    return group.hooks.some(
      (hook) =>
        isRecord(hook) &&
        hook.type === 'http' &&
        typeof hook.url === 'string' &&
        hook.url.includes(this.marker),
    )
  }
}

/**
 * Derive title and description from a Claude Code transcript JSONL file:
 *   - title:       the latest `summary` entry (Claude's own conversation title,
 *                  written on compaction), else the first genuine user message.
 *   - description: the latest genuine user message — what the chat is doing now.
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

  let summary: string | undefined
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
    if (!isRecord(entry)) {
      continue
    }

    if (entry.type === 'summary' && typeof entry.summary === 'string') {
      // Keep scanning; the last summary in the file is the most recent.
      summary = entry.summary
    } else if (entry.type === 'user') {
      const text = userMessageText(entry)
      if (text) {
        firstUserMessage ??= text
        // Keep overwriting; the last genuine user message is the most recent.
        lastUserMessage = text
      }
    }
  }

  return {
    title: firstLine(summary ?? firstUserMessage),
    description: firstLine(lastUserMessage),
  }
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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
