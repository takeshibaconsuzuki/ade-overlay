import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'socket.io-client'
import { createSocket } from '../../../src/shared/node/socket-client.ts'
import {
  callRpc,
  handleRpc,
  listenEvent,
  sendEvent,
} from '../../../src/shared/rpc.ts'
import {
  chatRequests,
  chatEvents,
  type ChatSnapshot,
} from '../../../src/shared/chats.ts'

import type { TerminalIdentities } from './terminal-identities.js'

// Consume the extension-host-only bootstrap once. Keep it out of processes
// spawned by extensions, while allowing controllers to reconnect/restart.
const extensionToken = process.env.ADE_CHAT_EXTENSION_TOKEN
delete process.env.ADE_CHAT_EXTENSION_TOKEN

export class ChatController implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>()
  readonly onDidChangeChats = this.changes.event
  private snapshot: ChatSnapshot = { chats: [] }
  private readonly activation = randomUUID()
  private readonly startedAt = Date.now()
  private socket?: Socket
  private stopped = false
  private readonly subscriptions: vscode.Disposable[] = []
  private focusGeneration = 0
  private focusId?: string
  private activeTerminalId?: string
  private selectedTerminal?: vscode.Terminal
  constructor(
    private readonly identities: Pick<
      TerminalIdentities,
      'id' | 'provider' | 'find' | 'onDidChange'
    >,
    private readonly coordinateFocus: <T>(
      operation: () => Promise<T>,
    ) => Promise<T>,
  ) {
    this.subscriptions.push(
      identities.onDidChange(() => this.updateSelection()),
    )
    this.connect()
  }

  selectTerminal(terminal: vscode.Terminal | undefined): void {
    this.selectedTerminal = terminal
    this.updateSelection()
  }

  private updateSelection(): void {
    const terminal = this.selectedTerminal
    const id =
      terminal && vscode.window.terminals.includes(terminal)
        ? this.identities.id(terminal)
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

  async activateChat(chatId: string): Promise<void> {
    if (!this.snapshot.chats.some((chat) => chat.id === chatId))
      throw new Error('This chat is no longer available.')
    if (!this.socket?.connected)
      throw new Error('Chat tracking is disconnected from the companion.')
    await callRpc(this.socket, chatRequests.activate, chatId)
  }

  private connect(): void {
    const endpoint = process.env.ADE_CHAT_ENDPOINT
    const token = extensionToken
    if (!endpoint || !token || this.stopped) return
    const url = new URL('/extension', endpoint)
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') return
    url.searchParams.set('activation', this.activation)
    url.searchParams.set('startedAt', String(this.startedAt))
    const socket = createSocket(url.href, {
      token,
      reconnectDelay: 2000,
      maxReconnectDelay: 2000,
    })
    this.socket = socket
    handleRpc(socket, chatRequests.paste, ({ terminalId, provider, text }) => {
      if (this.stopped || !socket.connected)
        throw new Error('Editor connection closed.')
      const terminal = this.identities.find(terminalId)
      if (!terminal || !vscode.window.terminals.includes(terminal))
        throw new Error('The chat terminal is no longer available.')
      if (this.identities.provider(terminal) !== provider)
        throw new Error('The chat provider changed. Try pasting again.')
      terminal.sendText(text, false)
      return null
    })
    handleRpc(socket, chatRequests.pasteTarget, () => {
      const terminal = vscode.window.activeTerminal
      // Pin the target now, but wait for launch to dispatch its command before
      // releasing a reservation. A queued query timing out cannot write input.
      return this.coordinateFocus(async () => {
        if (this.stopped || !socket.connected)
          throw new Error('Editor connection closed.')
        if (!terminal || !vscode.window.terminals.includes(terminal))
          throw new Error('There is no active terminal.')
        // Accepted limitation: after an extension-host restart, identity recovery
        // is asynchronous. Until recovery finishes, a restored ADE chat can look
        // ordinary here, allowing intercepted clipboard text through to its CLI.
        const terminalId = this.identities.id(terminal)
        if (!terminalId) return null
        const provider = this.identities.provider(terminal)
        if (!provider)
          throw new Error(
            'The chat provider is unavailable. Reopen this chat terminal.',
          )
        return { terminalId, provider }
      })
    })
    const invalid = () => socket.io.engine.close()
    listenEvent(
      socket,
      chatEvents.snapshot,
      (snapshot) => {
        this.snapshot = snapshot
        this.changes.fire()
      },
      invalid,
    )
    listenEvent(
      socket,
      chatEvents.cancelFocus,
      (id) => {
        if (this.focusId === id) this.focusGeneration++
      },
      invalid,
    )
    listenEvent(
      socket,
      chatEvents.focus,
      (message) => {
        const connection = socket.id
        this.focusId = message.id
        const generation = ++this.focusGeneration
        const acknowledge = (error?: string) => {
          if (socket.id === connection)
            sendEvent(socket, chatEvents.focused, {
              id: message.id,
              error: error?.slice(0, 1024),
            })
        }
        void this.focus(message.terminalId, generation).then(
          () => acknowledge(),
          (error: unknown) =>
            acknowledge(error instanceof Error ? error.message : String(error)),
        )
      },
      invalid,
    )
    socket.on('disconnect', () => {
      this.focusGeneration++
    })
    socket.connect()
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
      const terminal = this.identities.find(id)
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
    this.socket?.disconnect()
    this.changes.dispose()
    for (const disposable of this.subscriptions) disposable.dispose()
  }
}
