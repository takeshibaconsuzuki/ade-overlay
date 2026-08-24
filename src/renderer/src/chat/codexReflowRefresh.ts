// Codex rebuilds inline scrollback after finalizing a live agent-message tail.
// The rebuild starts with this hard-clear sequence, then writes the transcript
// in a DEC 2026 synchronized update. xterm 6 can leave its visible renderer
// stale when that happens while the user is scrolled up, even though its buffer
// contains the replayed rows. Detect the completed rebuild so the embedder can
// request one full repaint without changing or filtering the terminal bytes.
const CODEX_REFLOW_CLEAR = '\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H'
const SYNCHRONIZED_UPDATE_END = '\x1b[?2026l'

/**
 * Recognizes Codex's hard-clear followed by the end of its synchronized
 * transcript replay. PTY and WebSocket chunk boundaries are arbitrary, so the
 * detector retains only the suffix that could begin the next control sequence.
 */
export class CodexReflowRefreshDetector {
  private awaitingSynchronizedUpdateEnd = false
  private pending = ''

  push(data: string): boolean {
    let input = this.pending + data
    let refresh = false
    this.pending = ''

    while (input.length > 0) {
      const sequence = this.awaitingSynchronizedUpdateEnd
        ? SYNCHRONIZED_UPDATE_END
        : CODEX_REFLOW_CLEAR
      const index = input.indexOf(sequence)
      if (index === -1) {
        this.pending = input.slice(-(sequence.length - 1))
        break
      }

      input = input.slice(index + sequence.length)
      if (this.awaitingSynchronizedUpdateEnd) {
        refresh = true
        this.awaitingSynchronizedUpdateEnd = false
      } else {
        this.awaitingSynchronizedUpdateEnd = true
      }
    }

    return refresh
  }
}
