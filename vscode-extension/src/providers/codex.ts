import type { TerminalChatProvider } from '../terminal-chat-provider'
import type {
  ClipboardPart,
  TerminalPastePart,
} from '../../../src/shared/clipboard'
import type { ChatFileWriter } from '../chat-file-writer'

// Codex can combine rapid pastes despite bracketed boundaries; isolate image paths on both sides.
const IMAGE_PASTE_DELAY_MS = 200

export class CodexTerminalProvider implements TerminalChatProvider {
  readonly id = 'codex'

  async convertClipboard(
    parts: readonly ClipboardPart[],
    fileWriter: ChatFileWriter,
  ): Promise<TerminalPastePart[]> {
    const result: TerminalPastePart[] = []
    for (const part of parts) {
      if (part.type === 'text')
        result.push({
          text: new TextDecoder('utf-8', { fatal: true }).decode(part.data),
        })
      else if (part.type === 'image') {
        const path = await fileWriter.write(part.name, part.data)
        // Codex attaches an image only when its path is the entire paste event.
        result.push({
          text: `"${path}"`,
          beforeDelay: IMAGE_PASTE_DELAY_MS,
          afterDelay: IMAGE_PASTE_DELAY_MS,
        })
      } else {
        // Codex's own file completion quotes paths and follows them with a space, which
        // keeps spaces unambiguous and consecutive references apart.
        const path = await fileWriter.write(part.name, part.data)
        result.push({ text: `"${path}" ` })
      }
    }
    return result
  }
}
