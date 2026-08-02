const DEFAULT_OUTPUT_BUFFER_MS = 5

/**
 * Coalesces adjacent PTY writes so a terminal repaint reaches the renderer as
 * one WebSocket message. In particular, TUIs often flush their screen diff and
 * final cursor position separately; forwarding those writes independently can
 * expose the cursor movements used to paint the frame.
 */
export class TerminalOutputBuffer {
  private readonly chunks: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly onFlush: (data: string) => void,
    private readonly delayMs = DEFAULT_OUTPUT_BUFFER_MS,
  ) {}

  write(data: string): void {
    this.chunks.push(data)
    if (this.timer !== null) {
      return
    }
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.chunks.length === 0) {
      return
    }
    const data = this.chunks.join('')
    this.chunks.length = 0
    this.onFlush(data)
  }

  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.chunks.length = 0
  }
}
