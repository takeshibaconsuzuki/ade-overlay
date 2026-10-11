import { isVscodeSettingsDocument } from '../../../shared/vscode-utils'
import { logger } from '../../../shared/logger'

const log = logger.child({ component: 'settings-sync' })

export interface VscodeSettingsPage {
  applySettings(content: string, generation: number): Promise<void>
}

export interface VscodeSettingsServer {
  writeSettings(content: string): Promise<void>
}

// Owned by one editor page. Host snapshots replace whole documents; edits are accepted only after the current snapshot has been applied. Disconnected edits and stale completions are never replayed.
export class VscodeSettingsSync {
  private content: string | null = null
  private generation = 0
  private ready = false
  private active = false
  private closed = false
  private pending = Promise.resolve()

  constructor(
    private readonly page: VscodeSettingsPage,
    private readonly vscodeSettingsServer: VscodeSettingsServer,
  ) {}

  start(): void {
    if (this.closed) return
    this.active = true
    this.receive(this.content)
  }

  // Navigation or a renderer crash invalidates the old document's callbacks and pending work.
  stop(): void {
    this.active = false
    this.ready = false
    this.generation++
    this.pending = Promise.resolve()
  }

  // null invalidates readiness on disconnect or while the host document is unavailable.
  receive(content: string | null): void {
    if (this.closed || (content !== null && !isVscodeSettingsDocument(content)))
      return
    this.content = content
    const generation = ++this.generation
    this.ready = false
    if (!this.active || content === null) return
    const current = () => this.active && this.generation === generation
    this.pending = this.pending
      .then(async () => {
        if (!current()) return
        await this.page.applySettings(content, generation)
        if (current()) this.ready = true
      })
      .catch((error: unknown) => {
        if (current())
          log.error({ err: error }, 'Failed to apply host settings')
      })
  }

  async changed(generation: number, content: string): Promise<void> {
    if (
      !this.active ||
      this.content === null ||
      this.generation !== generation ||
      !isVscodeSettingsDocument(content)
    )
      return
    // IPC can arrive just before the host application is acknowledged. Wait, then recheck readiness; this is never an offline edit queue.
    await this.pending
    if (!this.active || !this.ready || this.generation !== generation) return
    if (content === this.content) return
    try {
      await this.vscodeSettingsServer.writeSettings(content)
    } catch (error) {
      log.warn({ err: error }, 'Unable to send settings to host')
    }
  }

  dispose(): void {
    this.closed = true
    this.stop()
  }
}
