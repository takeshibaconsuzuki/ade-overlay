import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  serverChatMessageSchema,
  type Chat,
  type ChatSnapshot,
  type ExtensionChatMessage,
  type TerminalInventory,
} from '../../../src/shared/chats.ts'

// Consume the extension-host-only bootstrap once. Keep it out of processes
// spawned by extensions, while allowing controllers to reconnect/restart.
const extensionToken = process.env.ADE_CHAT_EXTENSION_TOKEN
delete process.env.ADE_CHAT_EXTENSION_TOKEN

interface TerminalIdentity {
  terminalId: string
  pid: number
  startedAt?: string
}

async function terminalPid(
  terminal: vscode.Terminal,
  timeout = 1000,
): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      terminal.processId,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class ChatController implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>()
  readonly onDidChangeChats = this.changes.event
  private snapshot: ChatSnapshot = { revision: -1, chats: [] }
  private readonly activation = randomUUID()
  private readonly startedAt = Date.now()
  private readonly identities: Record<string, TerminalIdentity>
  private socket?: WebSocket
  private retry?: ReturnType<typeof setTimeout>
  private stopped = false
  private readonly pending = new Map<
    string,
    {
      resolve: (terminals?: TerminalInventory) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  private readonly subscriptions: vscode.Disposable[] = []
  private inventoryQueue?: Promise<void>
  private inventoryDirty = false
  private lastInventory?: string
  private readonly watchedPids = new WeakSet<vscode.Terminal>()
  private focusGeneration = 0
  private focusId?: string
  private activeTerminalId?: string
  private selectedTerminal?: vscode.Terminal
  private selectionGeneration = 0
  coordinateFocus: <T>(operation: () => Promise<T>) => Promise<T> = (
    operation,
  ) => operation()

  constructor(private readonly context: vscode.ExtensionContext) {
    this.identities = {
      ...context.workspaceState.get<Record<string, TerminalIdentity>>(
        'adeChatTerminals',
        {},
      ),
    }
    this.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (
          event.changed.some(
            (tab) => tab.input instanceof vscode.TabInputTerminal,
          )
        )
          void this.synchronize().catch(() => {})
      }),
      vscode.window.onDidOpenTerminal(
        () => void this.synchronize().catch(() => {}),
      ),
      vscode.window.onDidCloseTerminal((terminal) => {
        void terminal.processId.then((pid) => {
          if (pid) delete this.identities[String(pid)]
          void this.save()
          void this.synchronize().catch(() => {})
        })
      }),
    )
    this.connect()
  }

  prepare(): { terminalId: string; env: Record<string, string | null> } {
    const terminalId = randomUUID()
    return {
      terminalId,
      env: { ADE_TERMINAL_ID: terminalId, ADE_CHAT_EXTENSION_TOKEN: null },
    }
  }

  async created(terminal: vscode.Terminal, terminalId: string): Promise<void> {
    if (!process.env.ADE_CHAT_ENDPOINT || !extensionToken) return
    const pid = await terminalPid(terminal, 8000)
    if (!pid) throw new Error('The terminal process did not start.')
    this.identities[String(pid)] = { terminalId, pid }
    await this.save()
    const deadline = Date.now() + 8000
    while (
      this.socket?.readyState !== WebSocket.OPEN &&
      Date.now() < deadline &&
      !this.stopped
    )
      await new Promise((resolve) => setTimeout(resolve, 50))
    await this.synchronize()
    if (!this.identities[String(pid)]?.startedAt)
      throw new Error(
        'The terminal process identity could not be verified. Try again.',
      )
  }

  private save(): Thenable<void> {
    return this.context.workspaceState.update('adeChatTerminals', {
      ...this.identities,
    })
  }

  private synchronize(): Promise<void> {
    this.inventoryDirty = true
    this.inventoryQueue ??= (async () => {
      while (this.inventoryDirty) {
        this.inventoryDirty = false
        await this.synchronizeOnce()
      }
    })().finally(() => {
      this.inventoryQueue = undefined
    })
    return this.inventoryQueue
  }

  private async synchronizeOnce(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('Chat tracking is disconnected from the companion.')
    const inventory: TerminalInventory = []
    const terminals = await Promise.all(
      vscode.window.terminals.map(async (terminal) => {
        const pid = await terminalPid(terminal)
        if (!pid) this.synchronizeWhenPidReady(terminal)
        return { terminal, pid }
      }),
    )
    for (const { terminal, pid } of terminals) {
      if (!pid || !vscode.window.terminals.includes(terminal)) continue
      const id = this.identities[String(pid)]
      if (id) inventory.push({ ...id, title: terminal.name.slice(0, 512) })
    }
    const serialized = JSON.stringify(inventory)
    if (serialized === this.lastInventory) return
    const accepted = await this.request({
      type: 'inventory',
      id: randomUUID(),
      terminals: inventory,
    })
    this.lastInventory = serialized
    for (const entry of accepted ?? [])
      this.identities[String(entry.pid)] = {
        pid: entry.pid,
        terminalId: entry.terminalId,
        startedAt: entry.startedAt,
      }
    // A reused PID must not silently adopt a different terminal after restoration.
    for (const entry of inventory)
      if (!accepted?.some((item) => item.terminalId === entry.terminalId))
        delete this.identities[String(entry.pid)]
    await this.save()
    await this.updateSelection()
  }

  private synchronizeWhenPidReady(terminal: vscode.Terminal): void {
    if (this.watchedPids.has(terminal)) return
    this.watchedPids.add(terminal)
    // Restoring a PID can outlive the bounded inventory scan without another
    // terminal event. Subscribe once, and let the existing queue coalesce it.
    void terminal.processId.then(
      (pid) => {
        if (pid && !this.stopped && vscode.window.terminals.includes(terminal))
          void this.synchronize().catch(() => {})
      },
      () => {},
    )
  }

  selectTerminal(terminal: vscode.Terminal | undefined): void {
    this.selectedTerminal = terminal
    void this.updateSelection().catch(() => {})
  }

  private async updateSelection(): Promise<void> {
    const generation = ++this.selectionGeneration
    const terminal = this.selectedTerminal
    const pid = terminal ? await terminalPid(terminal) : undefined
    if (generation !== this.selectionGeneration || this.stopped) return
    const identity = pid ? this.identities[String(pid)] : undefined
    const terminalId =
      terminal &&
      vscode.window.terminals.includes(terminal) &&
      identity?.startedAt
        ? identity.terminalId
        : undefined
    if (this.activeTerminalId !== terminalId) {
      this.activeTerminalId = terminalId
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

  private request(
    message: ExtensionChatMessage,
  ): Promise<TerminalInventory | undefined> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error('Chat tracking is disconnected from the companion.'),
      )
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(message.id)
          reject(new Error('Chat request timed out. Try again.'))
        },
        message.type === 'activate' ? 35_000 : 8000,
      )
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
    this.lastInventory = undefined
    socket.on('open', () => {
      void this.synchronize().catch(() => socket.terminate())
    })
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
        else entry.resolve(message.terminals)
      } else if (message.type === 'cancel-focus') {
        if (this.focusId === message.id) this.focusGeneration++
      } else {
        this.focusId = message.id
        const generation = ++this.focusGeneration
        void this.coordinateFocus(() =>
          this.focus(message.terminalId, generation),
        )
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

  private async focus(terminalId: string, generation: number): Promise<void> {
    const deadline = Date.now() + 8000
    while (
      Date.now() < deadline &&
      generation === this.focusGeneration &&
      !this.stopped
    ) {
      for (const terminal of vscode.window.terminals) {
        const pid = await terminalPid(terminal)
        if (generation !== this.focusGeneration || this.stopped) break
        if (pid && this.identities[String(pid)]?.terminalId === terminalId) {
          terminal.show()
          while (
            Date.now() < deadline &&
            generation === this.focusGeneration &&
            !this.stopped
          ) {
            if (vscode.window.activeTerminal === terminal) return
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
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
    this.socket?.terminate()
    this.rejectPending(new Error('Extension stopped.'))
    this.changes.dispose()
    for (const disposable of this.subscriptions) disposable.dispose()
  }
}
