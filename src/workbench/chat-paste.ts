import type { DesktopWorkbenchMethods } from '../shared/editor-rpc'
import type { WorkbenchServices } from './services'
import {
  VscodeTerminalInput,
  type TerminalInputRaw,
  type TerminalInputTarget,
} from './terminal-input'

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export interface ChatPasteClipboard {
  paste(): Promise<void>
}

export interface ChatPasteTerminal extends TerminalInputTarget {
  readonly resource: unknown
  readonly processId: number | undefined
  readonly isDisposed: boolean
  readonly xtermReadyPromise: Promise<unknown>
  readonly xterm?: {
    raw: TerminalInputRaw & {
      element?: HTMLElement
      modes: { bracketedPasteMode: boolean }
      options: { ignoreBracketedPasteMode?: boolean }
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
        const xterm = terminal.xterm?.raw
        if (!xterm)
          throw new Error(
            'VS Code terminal input does not match the ADE integration',
          )
        const original = clipboard.paste
        let queue = Promise.resolve()
        let precedingPaste:
          { processId: number | undefined; failed: boolean } | undefined
        let buffering = false
        const enqueue = (
          operation: () => void | Promise<void>,
        ): Promise<void> => {
          const next: Promise<void> = queue
            .then(operation)
            .catch((error) => this.reportFailure(error))
            .finally(() => {
              if (queue === next) {
                buffering = false
                precedingPaste = undefined
              }
            })
          queue = next
          return next
        }
        const isCurrent = (processId: number | undefined) =>
          !this.closed &&
          this.installed.has(terminal) &&
          !terminal.isDisposed &&
          terminal.processId === processId &&
          terminal.xterm?.raw === xterm &&
          this.group.owns(terminal.resource)
        const input = new VscodeTerminalInput(terminal, xterm, (send) => {
          if (!buffering || !precedingPaste) return undefined
          const paste = precedingPaste
          return enqueue(async () => {
            if (paste.failed || !isCurrent(paste.processId)) return
            await send()
          })
        })
        clipboard.paste = () => {
          if (!this.group.owns(terminal.resource))
            return original.call(clipboard)
          const processId = terminal.processId
          const paste = { processId, failed: false }
          precedingPaste = paste
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
          return enqueue(async () => {
            try {
              const pastes = await prepared
              // Once insertion starts, input stays queued through later preparation waits until the queue drains.
              buffering = true
              for (const { text, beforeDelay = 0, afterDelay = 0 } of pastes) {
                if (!text) continue
                if (beforeDelay > 0) await delay(beforeDelay)
                // Revalidate after every delay, with no await between validation and insertion.
                if (!isCurrent(processId))
                  throw new Error('Chat terminal changed during paste')
                const xterm = terminal.xterm?.raw
                if (
                  !xterm?.modes.bracketedPasteMode ||
                  xterm.options.ignoreBracketedPasteMode
                )
                  throw new Error(
                    'The chat terminal is not ready for bracketed paste',
                  )
                input.paste(text)
                // Keep the queue occupied so subsequent requests respect the provider's trailing delay.
                if (afterDelay > 0) await delay(afterDelay)
              }
            } catch (error) {
              paste.failed = true
              throw error
            }
          })
        }
        this.installed.set(terminal, () => {
          clipboard.paste = original
          input.dispose()
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
