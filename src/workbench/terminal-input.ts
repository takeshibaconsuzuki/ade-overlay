export interface TerminalInputTarget {
  sendText(
    text: string,
    addNewLine?: boolean,
    bracketedPasteMode?: boolean,
  ): Promise<void>
}

export interface TerminalInputRaw {
  paste(text: string): void
  _core: {
    coreService: {
      triggerDataEvent(data: string, wasUserInput?: boolean): void
      triggerBinaryEvent(data: string): void
    }
  }
}

export interface TerminalInputAdapter {
  paste(text: string): void
  dispose(): void
}

// undefined leaves input synchronous; a promise defers or discards the operation.
type DeferInput = (
  send: () => void | Promise<void>,
) => Promise<void> | undefined

// Private input entry points of the pinned VS Code distribution. Protocol replies
// and ADE's own paste events bypass scheduling; user input shares the paste queue.
export class VscodeTerminalInput implements TerminalInputAdapter {
  private readonly restore: () => void
  private pasting = false

  constructor(
    terminal: TerminalInputTarget,
    private readonly raw: TerminalInputRaw,
    deferInput: DeferInput,
  ) {
    const core = raw._core?.coreService
    if (
      typeof core?.triggerDataEvent !== 'function' ||
      typeof core.triggerBinaryEvent !== 'function' ||
      typeof terminal.sendText !== 'function'
    )
      throw new Error(
        'VS Code terminal input does not match the ADE integration',
      )
    const originalData = core.triggerDataEvent
    const originalBinary = core.triggerBinaryEvent
    const originalSendText = terminal.sendText
    core.triggerDataEvent = (data, wasUserInput = false) => {
      const send = () => originalData.call(core, data, wasUserInput)
      if (!wasUserInput || this.pasting || !deferInput(send)) send()
    }
    core.triggerBinaryEvent = (data) => {
      const send = () => originalBinary.call(core, data)
      if (this.pasting || !deferInput(send)) send()
    }
    terminal.sendText = (...args) => {
      const send = () => originalSendText.apply(terminal, args)
      return deferInput(send) ?? send()
    }
    this.restore = () => {
      core.triggerDataEvent = originalData
      core.triggerBinaryEvent = originalBinary
      terminal.sendText = originalSendText
    }
  }

  paste(text: string): void {
    const previous = this.pasting
    this.pasting = true
    try {
      this.raw.paste(text)
    } finally {
      this.pasting = previous
    }
  }

  dispose(): void {
    this.restore()
  }
}
