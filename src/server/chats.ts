import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type {
  Chat,
  ChatReport,
  ChatSnapshot,
  ProcessIdentity,
} from '../shared/chats.ts'
import type { OpenEditorInput } from '../shared/companion.ts'
import { chatProvider } from './chat-providers.ts'
import {
  readChatProcesses,
  sameProcess,
  type ChatProcess,
} from './chat-processes.ts'

interface ChatRecord {
  chat: Chat
  process: ProcessIdentity
  editorId: string
  observedAt: number
  metadataRoot?: string
}

export class ChatStore extends EventEmitter<{ update: [ChatSnapshot] }> {
  private readonly records = new Map<string, ChatRecord>()
  private revision = 0
  private queue: Promise<unknown> = Promise.resolve()
  private titleRefresh?: Promise<void>

  // Capture admission time before the state queue: queued reports can share a
  // scan, while processes introduced after that scan require a newer one.
  private readonly processes: (
    notBefore: number,
  ) => Promise<Map<number, ChatProcess>>
  constructor(processes = readChatProcesses) {
    super()
    this.processes = processes
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  list(): ChatSnapshot {
    return {
      revision: this.revision,
      chats: [...this.records.values()]
        .map(({ chat }) => ({ ...chat }))
        .sort((a, b) => (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0)),
    }
  }

  get(id: string): { chat: Chat; editorId: string } | undefined {
    const entry = this.records.get(id)
    return entry && { chat: { ...entry.chat }, editorId: entry.editorId }
  }

  async activity(
    editorId: string,
    worktree: OpenEditorInput,
    report: ChatReport,
  ): Promise<boolean> {
    const requestedAt = performance.now()
    const accepted = await this.serial(async () => {
      const current = [...this.records.values()].find(
        (entry) =>
          entry.editorId === editorId &&
          entry.chat.terminalId === report.terminalId,
      )
      if (
        report.observedAt < (current?.observedAt ?? -1) ||
        report.observedAt > Date.now() + 5000
      )
        return false
      const provider = chatProvider(report.provider)
      if (!provider) return false
      const processes = await this.processes(requestedAt)
      const owner = processes.get(report.process.pid)
      if (
        !owner ||
        !sameProcess(report.process, owner) ||
        !provider.isProcess(owner)
      )
        return false
      const id = createHash('sha256')
        .update(
          `${editorId}\0${report.terminalId}\0${report.provider}\0${report.sessionId}`,
        )
        .digest('hex')
      // One visible conversation per terminal; a later session replaces the old one.
      for (const [previousId, entry] of this.records)
        if (entry === current && previousId !== id)
          this.records.delete(previousId)
      const previous = this.records.get(id)
      const message = report.message || previous?.chat.message
      const lastTurnAt = report.turnEvent
        ? report.observedAt
        : previous?.chat.lastTurnAt
      this.records.set(id, {
        editorId,
        observedAt: report.observedAt,
        process: report.process,
        metadataRoot: report.metadataRoot ?? previous?.metadataRoot,
        chat: {
          id,
          provider: report.provider,
          sessionId: report.sessionId,
          terminalId: report.terminalId,
          ...worktree,
          title: previous?.chat.title,
          message,
          lastTurnAt,
          activity: report.activity,
        },
      })
      if (
        !previous ||
        previous.chat.activity !== report.activity ||
        previous.chat.message !== message ||
        previous.chat.lastTurnAt !== lastTurnAt
      )
        this.publish()
      return true
    })
    if (accepted) void this.refreshTitles()
    return accepted
  }

  async reconcile(): Promise<void> {
    const requestedAt = performance.now()
    await this.serial(async () => {
      if (!this.records.size) return
      const processes = await this.processes(requestedAt)
      let changed = false
      for (const [id, entry] of this.records) {
        if (!sameProcess(entry.process, processes.get(entry.process.pid))) {
          this.records.delete(id)
          changed = true
        }
      }
      if (changed) this.publish()
    })
    await this.refreshTitles()
  }

  private refreshTitles(): Promise<void> {
    this.titleRefresh ??= (async () => {
      for (const [id, entry] of this.records) {
        const root = entry.metadataRoot
        const provider = chatProvider(entry.chat.provider)
        if (!root || !provider) continue
        const title = await provider
          .readTitle(root, entry.chat.sessionId)
          .catch(() => undefined)
        if (!title) continue
        await this.serial(async () => {
          const current = this.records.get(id)
          if (current?.metadataRoot === root && current.chat.title !== title) {
            current.chat.title = title
            this.publish()
          }
        })
      }
    })().finally(() => {
      this.titleRefresh = undefined
    })
    return this.titleRefresh
  }

  private publish(): void {
    this.revision++
    this.emit('update', this.list())
  }
  async settled(): Promise<void> {
    await this.titleRefresh
    await this.queue
  }
}
