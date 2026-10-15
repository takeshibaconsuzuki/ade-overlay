import type { ChatTerminalLaunch } from '../../src/shared/api'
import type { ClipboardPart } from '../../src/shared/clipboard'
import type { ImageFileWriter } from './image-file-writer'

export interface TerminalChatProvider {
  readonly id: string
  // The process must exit when the chat ends, without returning to a shell prompt.
  getLaunchOptions(): Pick<ChatTerminalLaunch, 'shellPath' | 'shellArgs'>
  // Converts parts on the terminal host. Each string is a separate paste, in source order, without submission.
  convertClipboard(
    parts: readonly ClipboardPart[],
    imageFileWriter: ImageFileWriter,
  ): Promise<string[]>
}
