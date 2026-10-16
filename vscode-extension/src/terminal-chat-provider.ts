import type {
  ClipboardPart,
  TerminalPastePart,
} from '../../src/shared/clipboard'
import type { ImageFileWriter } from './image-file-writer'

export interface TerminalChatProvider {
  readonly id: string
  // Converts parts on the terminal host. Each part is a separate paste, in source order, without submission.
  convertClipboard(
    parts: readonly ClipboardPart[],
    imageFileWriter: ImageFileWriter,
  ): Promise<TerminalPastePart[]>
}
