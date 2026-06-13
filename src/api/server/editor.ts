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

export type EditorCommand = EditorSwitchCommand | EditorCloseCommand
