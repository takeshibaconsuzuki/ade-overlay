import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  serverChatMessageSchema,
  processIdentitySchema,
  chatIdSchema,
  type Chat,
  type ChatSnapshot,
  type ExtensionChatMessage,
} from '../../../src/shared/chats.ts'

import {
  readChatProcesses,
  sameProcess,
} from '../../../src/server/chat-processes.ts'

const savedTerminalSchema = processIdentitySchema.extend({
  terminalId: chatIdSchema,
})
type SavedTerminal = { pid: number; startedAt: string; terminalId: string }

// Consume the extension-host-only bootstrap once. Keep it out of processes
// spawned by extensions, while allowing controllers to reconnect/restart.
const extensionToken = process.env.ADE_CHAT_EXTENSION_TOKEN
delete process.env.ADE_CHAT_EXTENSION_TOKEN

function terminalId(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions
  if (!('env' in options)) return undefined
  const id = options.env?.ADE_TERMINAL_ID
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export class ChatController implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>()
  readonly onDidChangeChats = this.changes.event
  private snapshot: ChatSnapshot = { revision: -1, chats: [] }
  private readonly activation = randomUUID()
  private readonly startedAt = Date.now()
  private socket?: WebSocket
  private retry?: ReturnType<typeof setTimeout>
  private stopped = false
  private readonly pending = new Map<
    string,
    {
      resolve: () => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  private readonly subscriptions: vscode.Disposable[] = []
  private focusGeneration = 0
  private focusId?: string
  private activeTerminalId?: string
  private selectedTerminal?: vscode.Terminal
  coordinateFocus: <T>(operation: () => Promise<T>) => Promise<T> = (
    operation,
  ) => operation()

  private readonly identities = new Map<vscode.Terminal, string>()
  private readonly saved = new Map<number, SavedTerminal>()
  private readonly recoveryTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'workspaceState'>,
    private readonly readProcesses = readChatProcesses,
  ) {
    const stored = context.workspaceState.get<Record<string, unknown>>(
      'adeChatTerminals',
      {},
    )
    for (const value of Object.values(stored)) {
      const entry = savedTerminalSchema.safeParse(value).data
      if (entry) this.saved.set(entry.pid, entry)
    }
    this.subscriptions.push(
      vscode.window.onDidOpenTerminal(
        (terminal) => void this.recover(terminal),
      ),
      vscode.window.onDidCloseTerminal((terminal) => {
        const id = this.id(terminal)
        this.identities.delete(terminal)
        for (const [pid, entry] of this.saved) {
          if (entry.terminalId === id) this.saved.delete(pid)
        }
        void this.save().catch(() => {})
        this.updateSelection()
      }),
    )
    for (const terminal of vscode.window.terminals) void this.recover(terminal)
    this.connect()
  }

  private id(terminal: vscode.Terminal): string | undefined {
    return terminalId(terminal) ?? this.identities.get(terminal)
  }

  private async save(): Promise<void> {
    await this.context.workspaceState.update(
      'adeChatTerminals',
      Object.fromEntries(this.saved),
    )
  }

  private async recover(terminal: vscode.Terminal): Promise<void> {
    const live = () =>
      !this.stopped && vscode.window.terminals.includes(terminal)
    if (!live()) return
    const id = terminalId(terminal)
    if (!id && this.saved.size === 0) return
    try {
      const pid = await terminal.processId
      if (!live() || !pid) return
      const processes = await this.readProcesses()
      if (!live()) return
      const process = processes.get(pid)
      const previous = this.saved.get(pid)
      for (const [savedPid, entry] of this.saved) {
        if (!sameProcess(entry, processes.get(savedPid)))
          this.saved.delete(savedPid)
      }
      const recovered =
        id ??
        (previous && sameProcess(previous, process)
          ? previous.terminalId
          : undefined)
      if (process && recovered) {
        this.identities.set(terminal, recovered)
        this.saved.set(pid, {
          pid,
          startedAt: process.startedAt,
          terminalId: recovered,
        })
        this.updateSelection()
      }
      await this.save()
      if (process || !id) return
    } catch {
      // Retry local bookkeeping independently of provider launch and transport.
    }
    if (live()) {
      const timer = setTimeout(() => {
        this.recoveryTimers.delete(timer)
        void this.recover(terminal)
      }, 2000)
      this.recoveryTimers.add(timer)
    }
  }

  selectTerminal(terminal: vscode.Terminal | undefined): void {
    this.selectedTerminal = terminal
    this.updateSelection()
  }

  private updateSelection(): void {
    const terminal = this.selectedTerminal
    const id =
      terminal && vscode.window.terminals.includes(terminal)
        ? this.id(terminal)
        : undefined
    if (this.activeTerminalId !== id) {
      this.activeTerminalId = id
      this.changes.fire()
    }
  }

  getActiveChatId(): string | undefined {
    return this.snapshot.chats.find(
      (chat) => chat.terminalId === this.activeTerminalId,
    )?.id
  }

  async activateChat(chat: Chat): Promise<void> {
    await this.request({ type: 'activate', id: randomUUID(), chatId: chat.id })
  }

  private request(message: ExtensionChatMessage): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error('Chat tracking is disconnected from the companion.'),
      )
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error('Chat request timed out. Try again.'))
      }, 35_000)
      this.pending.set(message.id, { resolve, reject, timeout })
      this.socket!.send(JSON.stringify(message), (error) => {
        if (error) this.rejectPending(error)
      })
    })
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private connect(): void {
    const endpoint = process.env.ADE_CHAT_ENDPOINT
    const token = extensionToken
    if (!endpoint || !token || this.stopped) return
    const url = new URL('/extension', endpoint)
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') return
    url.protocol = 'ws:'
    url.searchParams.set('activation', this.activation)
    url.searchParams.set('startedAt', String(this.startedAt))
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 5000,
      maxPayload: 16 * 1024 * 1024,
    })
    this.socket = socket
    socket.on('message', (data) => {
      if (socket !== this.socket) return
      let input: unknown
      try {
        input = JSON.parse(data.toString())
      } catch {
        socket.terminate()
        return
      }
      const message = serverChatMessageSchema.safeParse(input).data
      if (!message) {
        socket.terminate()
        return
      }
      if (message.type === 'snapshot') {
        if (message.snapshot.revision >= this.snapshot.revision) {
          this.snapshot = message.snapshot
          this.changes.fire()
        }
      } else if (message.type === 'result') {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        clearTimeout(entry.timeout)
        if (message.error) entry.reject(new Error(message.error))
        else entry.resolve()
      } else if (message.type === 'cancel-focus') {
        if (this.focusId === message.id) this.focusGeneration++
      } else {
        this.focusId = message.id
        const generation = ++this.focusGeneration
        void this.focus(message.terminalId, generation)
          .then(() => {
            if (socket.readyState === WebSocket.OPEN)
              socket.send(
                JSON.stringify({
                  type: 'focused',
                  id: message.id,
                } satisfies ExtensionChatMessage),
              )
          })
          .catch((error: unknown) => {
            if (socket.readyState === WebSocket.OPEN)
              socket.send(
                JSON.stringify({
                  type: 'focused',
                  id: message.id,
                  error: (error instanceof Error
                    ? error.message
                    : String(error)
                  ).slice(0, 1024),
                } satisfies ExtensionChatMessage),
              )
          })
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (socket !== this.socket) return
      this.socket = undefined
      this.focusGeneration++
      this.rejectPending(new Error('Chat tracking connection closed.'))
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 2000)
    })
  }

  private async focus(id: string, generation: number): Promise<void> {
    const deadline = Date.now() + 8000
    const current = () =>
      Date.now() < deadline &&
      generation === this.focusGeneration &&
      !this.stopped
    // Restoration is local and must not hold the workbench queue. Only showing
    // a resolved terminal shares the launcher's group/focus serialization.
    while (current()) {
      const terminal = vscode.window.terminals.find(
        (item) => this.id(item) === id,
      )
      if (terminal) {
        const focused = await this.coordinateFocus(async () => {
          if (!current() || !vscode.window.terminals.includes(terminal))
            return false
          terminal.show()
          while (current() && vscode.window.terminals.includes(terminal)) {
            if (vscode.window.activeTerminal === terminal) return true
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          return false
        })
        if (focused && current()) return
      }
      if (current()) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(
      'The chat terminal is no longer available or navigation was superseded.',
    )
  }

  getSnapshot(): ChatSnapshot {
    return this.snapshot
  }

  dispose(): void {
    this.stopped = true
    this.focusGeneration++
    clearTimeout(this.retry)
    for (const timer of this.recoveryTimers) clearTimeout(timer)
    this.socket?.terminate()
    this.rejectPending(new Error('Extension stopped.'))
    this.changes.dispose()
    for (const disposable of this.subscriptions) disposable.dispose()
  }
}
