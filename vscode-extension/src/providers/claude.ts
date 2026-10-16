import type { TerminalChatProvider } from '../terminal-chat-provider'
import type {
  ClipboardPart,
  TerminalPastePart,
} from '../../../src/shared/clipboard'
import type { ImageFileWriter } from '../image-file-writer'

// Claude Code attaches images asynchronously; isolate image paths so text keeps its order.
const IMAGE_PASTE_DELAY_MS = 200

export class ClaudeTerminalProvider implements TerminalChatProvider {
  readonly id = 'claude'

  async convertClipboard(
    parts: readonly ClipboardPart[],
    imageFileWriter: ImageFileWriter,
  ): Promise<TerminalPastePart[]> {
    const result: TerminalPastePart[] = []
    for (const part of parts) {
      if (part.type === 'text')
        result.push({
          text: new TextDecoder('utf-8', { fatal: true }).decode(part.data),
        })
      else {
        const path = await imageFileWriter.write(part.data)
        // Claude Code attaches pasted image paths and rejoins any other text in
        // that paste by lines. It unescapes backslashes in paths.
        result.push({
          text: path.replaceAll('\\', '\\\\'),
          beforeDelay: IMAGE_PASTE_DELAY_MS,
          afterDelay: IMAGE_PASTE_DELAY_MS,
        })
      }
    }
    return result
  }
}
