import { z } from 'zod/v4'
import { defineSseEvents, SSE_SNAPSHOT_EVENT } from './sse'
import { ErrorResponse, WorktreeId } from './worktrees'

export const EDITOR_BASE_PATH = '/editor'
export const EDITOR_BOOTSTRAP_PATH = '/__ade-overlay/editor-bootstrap'
export const EDITOR_COMMAND_STREAM_PATH = '/editorCommands'
export const EDITOR_COMMAND_ACK_PATH = '/editorCommandAcks'
export const EDITOR_EXTENSION_COMMAND_STREAM_PATH = '/editorExtensionCommands'
export const EDITOR_SESSION_STREAM_PATH = '/editorSessions'
export const EDITOR_SHOW_PATH = '/showEditor'

export type EditorSwitchCommand = {
  type: 'switch'
  worktreeId: WorktreeId
  url: string
}

export type EditorShowCommand = {
  type: 'show'
}

export type EditorCloseCommand = {
  type: 'close'
  commandId: string
  worktreeId: WorktreeId
}

export type EditorOpenFileCommand = {
  type: 'open-file'
  worktreeId: WorktreeId
  url: string
  filePath: string
}

export type EditorCommand =
  | EditorSwitchCommand
  | EditorShowCommand
  | EditorCloseCommand
  | EditorOpenFileCommand

export const EditorSwitchCommand = z.object({
  type: z.literal('switch'),
  worktreeId: WorktreeId,
  url: z.string(),
})

export const EditorShowCommand = z.object({
  type: z.literal('show'),
})

export const EditorCloseCommand = z.object({
  type: z.literal('close'),
  commandId: z.string(),
  worktreeId: WorktreeId,
})

export const EditorOpenFileCommand = z.object({
  type: z.literal('open-file'),
  worktreeId: WorktreeId,
  url: z.string(),
  filePath: z.string(),
})

export const EditorCommand = z.discriminatedUnion('type', [
  EditorSwitchCommand,
  EditorShowCommand,
  EditorCloseCommand,
  EditorOpenFileCommand,
])

export const EditorCommandSseEvents = defineSseEvents({
  switch: EditorSwitchCommand,
  show: EditorShowCommand,
  close: EditorCloseCommand,
  'open-file': EditorOpenFileCommand,
})

export const EditorCommandStreamResponse = z
  .string()
  .describe('Server-sent editor switch commands.')

/** Whether a worktree's VS Code session is stopped, starting, or running. */
export type EditorSessionStatusValue = 'off' | 'starting' | 'on'

export type EditorSessionStatus = {
  worktreeId: WorktreeId
  status: EditorSessionStatusValue
  lastSwitchAt?: string
}

export const EditorSessionStatusValue = z.enum(['off', 'starting', 'on'])

export const EditorSessionStatus = z.object({
  worktreeId: WorktreeId,
  status: EditorSessionStatusValue,
  lastSwitchAt: z.string().optional(),
})

export const EditorSessionSnapshot = z.array(EditorSessionStatus)

/** SSE event name for incremental editor-session status changes. */
export const EDITOR_SESSION_STATUS_EVENT = 'session-status'

export const EditorSessionSseEvents = defineSseEvents({
  [SSE_SNAPSHOT_EVENT]: EditorSessionSnapshot,
  [EDITOR_SESSION_STATUS_EVENT]: EditorSessionStatus,
})

export const EditorSessionStreamResponse = z
  .string()
  .describe('Server-sent editor session status events.')

export const EDITOR_EXTENSION_OPEN_FILE_EVENT = 'open-file'

export const EditorExtensionCommandQuery = z.object({
  worktreeId: WorktreeId,
})

export const EditorExtensionOpenFileCommand = z.object({
  filePath: z.string().min(1),
})

export const EditorExtensionCommandSseEvents = defineSseEvents({
  [EDITOR_EXTENSION_OPEN_FILE_EVENT]: EditorExtensionOpenFileCommand,
})

export const EditorWorktreeRequest = z.object({
  worktreeId: WorktreeId,
})

export const EditorWorktreeResponse = z.object({
  worktreeId: WorktreeId,
  url: z.string(),
  alreadyStarted: z.boolean(),
})

export const EditorCommandAckRequest = z.object({
  commandId: z.string().min(1),
})

export const EditorCommandAckResponse = z.object({
  ok: z.literal(true),
})

export const OpenCreationLogsResponse = z.object({
  ok: z.literal(true),
})

export { ErrorResponse }

export type EditorCommandAckRequest = z.infer<typeof EditorCommandAckRequest>
export type EditorCommandAckResponse = z.infer<typeof EditorCommandAckResponse>
export type EditorExtensionCommandQuery = z.infer<
  typeof EditorExtensionCommandQuery
>
export type EditorExtensionOpenFileCommand = z.infer<
  typeof EditorExtensionOpenFileCommand
>
export type EditorSessionSnapshot = z.infer<typeof EditorSessionSnapshot>
export type EditorWorktreeRequest = z.infer<typeof EditorWorktreeRequest>
export type EditorWorktreeResponse = z.infer<typeof EditorWorktreeResponse>
export type EditorCommandSseEvents = typeof EditorCommandSseEvents
export type EditorSessionSseEvents = typeof EditorSessionSseEvents
export type EditorExtensionCommandSseEvents =
  typeof EditorExtensionCommandSseEvents
