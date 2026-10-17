import type {
  ClipboardPart,
  TerminalPastePart,
} from '../../src/shared/clipboard'
import type { ChatFileWriter } from './chat-file-writer'

export interface TerminalChatProvider {
  readonly id: string
  // Converts parts on the terminal host. Each part is a separate paste, in source order, without submission.
  convertClipboard(
    parts: readonly ClipboardPart[],
    fileWriter: ChatFileWriter,
  ): Promise<TerminalPastePart[]>
}
