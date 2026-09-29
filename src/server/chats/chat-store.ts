import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type {
  Chat,
  ChatReport,
  ChatSnapshot,
  ProcessIdentity,
} from '../../shared/chats.ts'
import type { OpenEditorInput } from '../../shared/companion.ts'
import type { WorktreeColor } from '../../shared/worktree-colors.ts'
import {
  chatProvider,
  type ChatProvider,
  type ChatTitles,
} from './chat-providers.ts'
import {
  readChatProcesses,
  sameProcess,
  type ChatProcess,
} from '../../shared/node/chat-processes.ts'

interface ChatRecord {
  chat: Chat
  provider: string
  worktree: OpenEditorInput
  sessionId: string
  lastTurnAt?: number
  process: ProcessIdentity
  editorId: string
  observedAt: number
  metadataRoot?: string
}

export class ChatStore extends EventEmitter<{
  update: [ChatSnapshot]
  idle: [Chat]
}> {
  private readonly records = new Map<string, ChatRecord>()
  private queue: Promise<unknown> = Promise.resolve()
  private titleRefresh?: Promise<void>
  private titlesPending = false
  private closed = false

  // Capture admission time before the state queue: queued reports can share a
  // scan, while processes introduced after that scan require a newer one.
  private readonly processes: (
    notBefore: number,
  ) => Promise<Map<number, ChatProcess>>
  private readonly color: (
    worktree: OpenEditorInput,
  ) => WorktreeColor | undefined

  constructor(
    processes = readChatProcesses,
    color: (worktree: OpenEditorInput) => WorktreeColor | undefined = () =>
      undefined,
  ) {
    super()
    this.processes = processes
    this.color = color
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  list(): ChatSnapshot {
    return {
      chats: [...this.records.values()]
        .sort((a, b) => (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0))
        .map(({ chat }) => ({ ...chat })),
    }
  }

  get(
    id: string,
  ): { chat: Chat; editorId: string; worktree: OpenEditorInput } | undefined {
    const entry = this.records.get(id)
    return (
      entry && {
        chat: { ...entry.chat },
        editorId: entry.editorId,
        worktree: { ...entry.worktree },
      }
    )
  }

  async activity(
    editorId: string,
    worktree: OpenEditorInput,
    report: ChatReport,
  ): Promise<boolean> {
    const requestedAt = performance.now()
    let inserted = false
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
      const becameIdle =
        previous?.chat.activity === 'working' && report.activity === 'idle'
      const message = report.message || previous?.chat.message
      const lastTurnAt = report.turnEvent
        ? report.observedAt
        : previous?.lastTurnAt
      const changed =
        !previous ||
        previous.chat.activity !== report.activity ||
        previous.chat.message !== message ||
        previous.lastTurnAt !== lastTurnAt
      const next: ChatRecord = {
        editorId,
        provider: report.provider,
        worktree: { ...worktree },
        sessionId: report.sessionId,
        lastTurnAt,
        observedAt: report.observedAt,
        process: report.process,
        metadataRoot: report.metadataRoot ?? previous?.metadataRoot,
        chat: {
          id,
          terminalId: report.terminalId,
          path: worktree.path,
          color: this.color(worktree),
          title: previous?.chat.title,
          message,
          activity: report.activity,
        },
      }
      // Keep the record identity across activity updates so a title read can
      // distinguish this conversation from one removed and inserted again.
      this.records.set(id, previous ? Object.assign(previous, next) : next)
      inserted = !previous
      if (changed) this.publish()
      if (becameIdle) this.emit('idle', { ...next.chat })
      return true
    })
    if (inserted) {
      this.titlesPending = true
      void this.refreshTitles()
    }
    return accepted
  }

  // Live processes may outlast their editor. Refresh presentation on editor
  // status changes without changing chat membership or waiting for activity.
  refreshColors(): void {
    if (this.closed) return
    let changed = false
    for (const entry of this.records.values()) {
      const color = this.color(entry.worktree)
      if (entry.chat.color !== color) {
        entry.chat.color = color
        changed = true
      }
    }
    if (changed) this.publish()
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
  }

  refreshTitles(): Promise<void> {
    if (this.closed) return Promise.resolve()
    // Periodic ticks reuse the active job. Only a new insertion requests a
    // follow-up pass, coalescing all arrivals while metadata is being read.
    this.titleRefresh ??= Promise.resolve().then(async () => {
      try {
        do {
          this.titlesPending = false
          await this.readTitles()
        } while (this.titlesPending && !this.closed)
      } finally {
        this.titleRefresh = undefined
      }
    })
    return this.titleRefresh
  }

  private async readTitles(): Promise<void> {
    const groups = new Map<ChatProvider, Map<string, Set<string>>>()
    const entries = [...this.records.values()].flatMap((entry) => {
      const root = entry.metadataRoot
      const provider = chatProvider(entry.provider)
      if (!root || !provider) return []
      const roots = groups.get(provider) ?? new Map<string, Set<string>>()
      const sessions = roots.get(root) ?? new Set<string>()
      sessions.add(entry.sessionId)
      roots.set(root, sessions)
      groups.set(provider, roots)
      return [{ entry, root, provider }]
    })
    const results = new Map(
      await Promise.all(
        [...groups].map(
          async ([provider, roots]) =>
            [
              provider,
              await provider
                .readTitles(roots)
                .catch((): ChatTitles => new Map()),
            ] as const,
        ),
      ),
    )
    await this.serial(async () => {
      if (this.closed) return
      let changed = false
      for (const { entry, root, provider } of entries) {
        const title = results.get(provider)?.get(root)?.get(entry.sessionId)
        if (
          title &&
          this.records.get(entry.chat.id) === entry &&
          entry.metadataRoot === root &&
          entry.chat.title !== title
        ) {
          entry.chat.title = title
          changed = true
        }
      }
      if (changed) this.publish()
    })
  }

  private publish(): void {
    this.emit('update', this.list())
  }
  async settled(): Promise<void> {
    await this.queue
    await this.titleRefresh
    await this.queue
  }

  async close(): Promise<void> {
    this.closed = true
    await this.settled()
  }
}
