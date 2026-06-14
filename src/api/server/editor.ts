export const EDITOR_BASE_PATH = '/editor'
export const EDITOR_BOOTSTRAP_PATH = '/__ade-overlay/editor-bootstrap'
export const EDITOR_COMMAND_ACK_PATH = '/editorCommandAcks'

export type EditorSwitchCommand = {
  type: 'switch'
  worktreeId: string
  url: string
}

export type EditorCloseCommand = {
  type: 'close'
  commandId: string
  worktreeId: string
}

export type EditorOpenFileCommand = {
  type: 'open-file'
  worktreeId: string
  url: string
  filePath: string
}

export type EditorCommand =
  | EditorSwitchCommand
  | EditorCloseCommand
  | EditorOpenFileCommand

/** Whether a worktree's VS Code session is stopped, starting, or running. */
export type EditorSessionStatusValue = 'off' | 'starting' | 'on'

export type EditorSessionStatus = {
  worktreeId: string
  status: EditorSessionStatusValue
}

/** SSE event name for incremental editor-session status changes. */
export const EDITOR_SESSION_STATUS_EVENT = 'session-status'
