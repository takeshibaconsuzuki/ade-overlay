import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import type { ChatHistoryIndexer } from './chat-history'

// Runs each update in its own process, so reading transcripts and writing the index never
// pause the server's event loop.
export class ProcessChatHistoryIndexer implements ChatHistoryIndexer {
  private running: { child: ChildProcess; exited: Promise<unknown> } | undefined
  private closed = false

  // The command performs one update and exits with status 0 when it succeeds.
  constructor(private readonly command: readonly [string, ...string[]]) {}

  async update(): Promise<void> {
    if (this.closed) return
    if (this.running)
      throw new Error('A chat history update is already running')
    const [file, ...args] = this.command
    const child = spawn(file, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    })
    const exited = once(child, 'exit')
    this.running = { child, exited }
    try {
      const [code, signal] = (await exited) as [
        number | null,
        NodeJS.Signals | null,
      ]
      if (code !== 0 && !this.closed)
        throw new Error(`Chat history update exited with ${code ?? signal}`)
    } finally {
      this.running = undefined
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const running = this.running
    if (!running) return
    running.child.kill()
    await running.exited.catch(() => {})
  }
}
