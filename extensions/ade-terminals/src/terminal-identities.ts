import * as vscode from 'vscode'
import {
  processIdentitySchema,
  chatIdSchema,
} from '../../../src/shared/chats.ts'
import {
  readChatProcesses,
  sameProcess,
} from '../../../src/shared/node/chat-processes.ts'

const savedTerminalSchema = processIdentitySchema.extend({
  terminalId: chatIdSchema,
})
type SavedTerminal = { pid: number; startedAt: string; terminalId: string }
interface TerminalEntry {
  id?: string
  retry?: ReturnType<typeof setTimeout>
}

export class TerminalIdentities implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changes.event
  private readonly terminals = new Map<vscode.Terminal, TerminalEntry>()
  private readonly saved = new Map<number, SavedTerminal>()
  private readonly subscriptions: vscode.Disposable[]
  private writes: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly storage: vscode.Memento,
    private readonly readProcesses = readChatProcesses,
  ) {
    const stored = storage.get<Record<string, unknown>>('adeChatTerminals', {})
    for (const value of Object.values(stored)) {
      const entry = savedTerminalSchema.safeParse(value).data
      if (entry) this.saved.set(entry.pid, entry)
    }
    this.subscriptions = [
      vscode.window.onDidOpenTerminal((terminal) => this.track(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => {
        const entry = this.terminals.get(terminal)
        clearTimeout(entry?.retry)
        this.terminals.delete(terminal)
        for (const [pid, saved] of this.saved) {
          if (saved.terminalId === entry?.id) this.saved.delete(pid)
        }
        void this.save().catch(() => {})
        this.changes.fire()
      }),
    ]
    for (const terminal of vscode.window.terminals) this.track(terminal)
  }

  register(terminal: vscode.Terminal, id: string): void {
    if (this.stopped) return
    clearTimeout(this.terminals.get(terminal)?.retry)
    // Replace any recovery started by onDidOpenTerminal. Its pending scan must
    // never overwrite an explicit registration or prune newer saved identities.
    const entry = { id }
    this.terminals.set(terminal, entry)
    this.changes.fire()
    void this.recover(terminal, entry)
  }

  id(terminal: vscode.Terminal): string | undefined {
    return this.terminals.get(terminal)?.id
  }

  find(id: string): vscode.Terminal | undefined {
    return vscode.window.terminals.find((terminal) => this.id(terminal) === id)
  }

  private track(terminal: vscode.Terminal): void {
    if (this.stopped || this.terminals.has(terminal) || this.saved.size === 0)
      return
    const entry = {}
    this.terminals.set(terminal, entry)
    void this.recover(terminal, entry)
  }

  private save(): Promise<void> {
    const writing = this.writes.then(async () => {
      if (!this.stopped)
        await this.storage.update(
          'adeChatTerminals',
          Object.fromEntries(this.saved),
        )
    })
    this.writes = writing.catch(() => {})
    return writing
  }

  private async recover(
    terminal: vscode.Terminal,
    entry: TerminalEntry,
  ): Promise<void> {
    const current = () =>
      !this.stopped &&
      this.terminals.get(terminal) === entry &&
      vscode.window.terminals.includes(terminal)
    try {
      const pid = await terminal.processId
      if (!current()) return
      if (pid) {
        const previous = this.saved.get(pid)
        if (!entry.id && !previous) return
        const savedBeforeScan = new Map(this.saved)
        const processes = await this.readProcesses()
        if (!current()) return
        for (const [savedPid, saved] of savedBeforeScan) {
          if (
            this.saved.get(savedPid) === saved &&
            !sameProcess(saved, processes.get(savedPid))
          )
            this.saved.delete(savedPid)
        }
        const process = processes.get(pid)
        const recovered =
          entry.id ??
          (previous && sameProcess(previous, process)
            ? previous.terminalId
            : undefined)
        if (process && recovered) {
          const changed = entry.id !== recovered
          entry.id = recovered
          this.saved.set(pid, {
            pid,
            startedAt: process.startedAt,
            terminalId: recovered,
          })
          if (changed) this.changes.fire()
        }
        await this.save()
        if (process || !entry.id) return
      }
    } catch {
      // Process discovery and storage retries never hold the placement queue.
    }
    if (current()) {
      entry.retry = setTimeout(() => {
        entry.retry = undefined
        void this.recover(terminal, entry)
      }, 2000)
    }
  }

  dispose(): void {
    this.stopped = true
    for (const entry of this.terminals.values()) clearTimeout(entry.retry)
    for (const subscription of this.subscriptions) subscription.dispose()
    this.terminals.clear()
    this.changes.dispose()
  }
}
