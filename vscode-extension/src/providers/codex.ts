import type { TerminalChatProvider } from '../terminal-chat-provider'
import type {
  ClipboardPart,
  TerminalPastePart,
} from '../../../src/shared/clipboard'
import type { ImageFileWriter } from '../image-file-writer'

// Codex can combine rapid pastes despite bracketed boundaries; isolate image paths on both sides.
const IMAGE_PASTE_DELAY_MS = 200

export class CodexTerminalProvider implements TerminalChatProvider {
  readonly id = 'codex'

  getLaunchOptions() {
    // A command shell resolves npm's Windows shim as well as native executables.
    return process.platform === 'win32'
      ? {
          shellPath: process.env.ComSpec ?? 'cmd.exe',
          shellArgs: ['/d', '/c', 'codex'],
        }
      : { shellPath: '/bin/sh', shellArgs: ['-c', 'exec codex'] }
  }

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
        // Codex attaches an image only when its path is the entire paste event.
        result.push({
          text: `"${path}"`,
          beforeDelay: IMAGE_PASTE_DELAY_MS,
          afterDelay: IMAGE_PASTE_DELAY_MS,
        })
      }
    }
    return result
  }
}
