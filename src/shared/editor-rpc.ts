import type { ChatTerminalLaunch, ExtensionIdentifier } from './api'
import type { ClipboardPart, TerminalPastePart } from './clipboard'

export const DESKTOP_RPC_COMMAND = 'ade.desktopRpc'
export const EXTENSION_RPC_COMMAND = 'ade.extensionRpc'
export const EDITOR_RPC_CONNECT = 'ade:rpc:connect'
export const EDITOR_RPC_MESSAGE = 'ade:rpc:message'

export interface DesktopChatMethods {
  // Acknowledges opening; the desktop retries terminal focus until ready or superseded.
  openChat(id: string): Promise<void>
  openChatTerminal(options: ChatTerminalLaunch): Promise<void>
}

export interface DesktopClipboardMethods {
  // Returns ordered parts from one snapshot; unsupported representations are logged and return no parts.
  readClipboard(): Promise<ClipboardPart[]>
}

export interface DesktopExtensionMethods
  extends DesktopChatMethods, DesktopClipboardMethods {}

export interface ExtensionMethods {
  focusChatTerminal(id: string): boolean
  // Uses the chat terminal's provider to convert the desktop clipboard into separate, ordered pastes.
  // undefined means this process has no chat identity; retain native paste.
  prepareChatPaste(processId: number): Promise<TerminalPastePart[] | undefined>
}

export interface DesktopWorkbenchMethods {
  getDisabledExtensions(): Promise<ExtensionIdentifier[]>
  settingsChanged(generation: number, content: string): Promise<void>
  ready(): void
  startupFailed(message: string): void
  // Returns ordered paste events, or undefined for a process without a chat identity. Preparation failures reject.
  prepareChatPaste(processId: number): Promise<TerminalPastePart[] | undefined>
}

export interface WorkbenchMethods {
  openChatTerminal(options: ChatTerminalLaunch): Promise<void>
  applySettings(content: string, generation: number): Promise<void>
  persistSession(): Promise<void>
}

// Extension sessions are independent of document sessions: an extension host can restart
// without reloading its workbench. Old sessions must never deliver calls to a new peer.
export type ExtensionMessage =
  | { type: 'connect' | 'disconnect'; session: string }
  | { type: 'message'; session: string; message: string }

export type EditorMessage =
  | { target: 'workbench'; message: string }
  | { target: 'extension'; call: ExtensionMessage }

// The only page global. It carries messages and never exposes VS Code services or Electron.
export interface DesktopBridge {
  setHandleCall(callback: (call: EditorMessage) => void): Promise<void>
  post(call: EditorMessage): Promise<void>
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!value || typeof value !== 'object') return false
  const call = value as ExtensionMessage
  return (
    typeof call.session === 'string' &&
    call.session.length > 0 &&
    (call.type === 'connect' ||
      call.type === 'disconnect' ||
      (call.type === 'message' && typeof call.message === 'string'))
  )
}

export function isEditorMessage(value: unknown): value is EditorMessage {
  if (!value || typeof value !== 'object') return false
  const call = value as EditorMessage
  return (
    (call.target === 'workbench' && typeof call.message === 'string') ||
    (call.target === 'extension' && isExtensionMessage(call.call))
  )
}
