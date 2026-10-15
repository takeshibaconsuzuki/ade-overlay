import type { DesktopWorkbenchMethods } from '../shared/editor-rpc'
import type { WorkbenchServices } from './services'

export interface ChatPasteClipboard {
  paste(): Promise<void>
}

export interface ChatPasteTerminal {
  readonly resource: unknown
  readonly processId: number | undefined
  readonly isDisposed: boolean
  readonly xtermReadyPromise: Promise<unknown>
  readonly xterm?: {
    raw: {
      element?: HTMLElement
      modes: { bracketedPasteMode: boolean }
      options: { ignoreBracketedPasteMode?: boolean }
      paste(text: string): void
    }
  }
  getContribution(id: string): ChatPasteClipboard | null
}

export interface ChatPasteGroup {
  owns(resource: unknown): boolean
}

interface Disposable {
  dispose(): void
}

export interface ChatPasteTerminals {
  readonly instances: readonly ChatPasteTerminal[]
  onDidCreateInstance(
    listener: (terminal: ChatPasteTerminal) => void,
  ): Disposable
  onDidDisposeInstance(
    listener: (terminal: ChatPasteTerminal) => void,
  ): Disposable
}

// Preparation runs in parallel; insertion stays bound to the original terminal and follows request order.
// Chat pastes use bracketed input without shell-paste confirmation or submission.
export class ChatPaste {
  private readonly terminals: ChatPasteTerminals
  private readonly installed = new Map<ChatPasteTerminal, () => void>()
  private readonly subscriptions: Disposable[]
  private closed = false

  constructor(
    private readonly handle: WorkbenchServices,
    private readonly group: ChatPasteGroup,
    private readonly desktop: DesktopWorkbenchMethods,
  ) {
    this.terminals = handle.get('terminalService') as ChatPasteTerminals
    const terminals = this.terminals
    this.subscriptions = [
      terminals.onDidCreateInstance((terminal) => this.install(terminal)),
      terminals.onDidDisposeInstance((terminal) => {
        this.installed.get(terminal)?.()
        this.installed.delete(terminal)
      }),
    ]
    terminals.instances.forEach((terminal) => this.install(terminal))
  }

  private install(terminal: ChatPasteTerminal): void {
    void terminal.xtermReadyPromise
      .then(() => {
        if (this.closed || terminal.isDisposed || this.installed.has(terminal))
          return
        const clipboard = terminal.getContribution('terminal.clipboard')
        if (!clipboard)
          throw new Error(
            'VS Code terminal clipboard does not match the ADE integration',
          )
        const original = clipboard.paste
        let queue = Promise.resolve()
        clipboard.paste = () => {
          if (!this.group.owns(terminal.resource))
            return original.call(clipboard)
          const processId = terminal.processId
          const prepared =
            processId === undefined
              ? Promise.reject(new Error('The chat terminal is not ready'))
              : Promise.resolve().then(async () => {
                  const pastes = await this.desktop.prepareChatPaste(processId)
                  if (pastes !== undefined) return pastes
                  // An ordinary terminal uses native paste without waiting for the chat insertion queue.
                  await original.call(clipboard)
                  return []
                })
          // Preparation starts immediately to capture each clipboard, while insertion remains ordered.
          void prepared.catch(() => {})
          const operation = queue.then(async () => {
            const pastes = await prepared
            // No await between validation and insertion: ownership cannot change during a dialog.
            for (const text of pastes) {
              if (
                this.closed ||
                terminal.isDisposed ||
                terminal.processId !== processId ||
                !this.group.owns(terminal.resource)
              )
                throw new Error('Chat terminal changed during paste')
              if (!text) continue
              const xterm = terminal.xterm?.raw
              if (
                !xterm?.modes.bracketedPasteMode ||
                xterm.options.ignoreBracketedPasteMode
              )
                throw new Error(
                  'The chat terminal is not ready for bracketed paste',
                )
              xterm.paste(text)
            }
          })
          queue = operation.catch((error) => this.reportFailure(error))
          return queue
        }
        this.installed.set(terminal, () => {
          clipboard.paste = original
        })
      })
      .catch((error) => {
        if (
          !this.closed &&
          !terminal.isDisposed &&
          this.group.owns(terminal.resource)
        )
          this.reportFailure(error)
      })
  }

  private reportFailure(error: unknown): void {
    console.error('Unable to paste into chat terminal', error)
    const notifications = this.handle.get('notificationService') as {
      error(message: string): void
    }
    notifications.error(
      'Unable to paste into the chat terminal. Check the logs and retry.',
    )
  }

  // Native browser paste can bypass the VS Code command (for example, an Electron menu action).
  handleNativePaste(event: ClipboardEvent): void {
    if (!(event.target instanceof Node)) return
    const target = event.target
    const terminal = this.terminals.instances.find((candidate) =>
      candidate.xterm?.raw.element?.contains(target),
    )
    if (
      !terminal ||
      !this.installed.has(terminal) ||
      !this.group.owns(terminal.resource)
    )
      return
    event.preventDefault()
    event.stopImmediatePropagation()
    void terminal.getContribution('terminal.clipboard')!.paste()
  }

  dispose(): void {
    this.closed = true
    this.subscriptions.forEach((subscription) => subscription.dispose())
    for (const restore of this.installed.values()) restore()
    this.installed.clear()
  }
}

export function installChatPaste(
  handle: WorkbenchServices,
  group: ChatPasteGroup,
  desktop: DesktopWorkbenchMethods,
): void {
  const paste = new ChatPaste(handle, group, desktop)
  const listener = (event: ClipboardEvent) => paste.handleNativePaste(event)
  document.addEventListener('paste', listener, true)
  window.addEventListener(
    'pagehide',
    () => {
      document.removeEventListener('paste', listener, true)
      paste.dispose()
    },
    { once: true },
  )
}
