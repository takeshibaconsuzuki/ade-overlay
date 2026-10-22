import timers from 'node:timers/promises'
import type { ConnectionState } from '../shared/api'
import { logger } from '../shared/logger'
import type {
  TerminalProcess,
  TerminalProcessFactory,
} from './terminal-process'

const log = logger.child({ component: 'desktop-start-command' })

// The restart loop is independent of connection attempts and picker visibility.
// Only losing an established connection or quitting terminates a running command.
export class DesktopStartCommand {
  private readonly controller = new AbortController()
  private readonly done: Promise<void>
  private current: TerminalProcess | undefined
  private stopping: Promise<void> | undefined
  private connected = false
  private cols = 80
  private rows = 24
  private output = ''

  constructor(
    private readonly command: string,
    private readonly factory: TerminalProcessFactory,
    private readonly onData: (data: string) => void,
  ) {
    this.done = this.run()
  }

  get history(): string {
    return this.output
  }

  write(data: string): void {
    this.current?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.current?.resize(cols, rows)
  }

  connectionChanged(state: ConnectionState): void {
    const disconnected = this.connected && state !== 'connected'
    this.connected = state === 'connected'
    if (disconnected && !this.controller.signal.aborted) {
      this.stopping = this.current?.stop()
      void this.stopping?.catch((error: unknown) => {
        log.error({ err: error }, 'Failed to stop desktop startCommand')
        this.report('Unable to stop startCommand after disconnect.')
      })
    }
  }

  async close(): Promise<void> {
    this.controller.abort()
    await this.current?.stop()
    await this.done
  }

  private emit(data: string): void {
    // Retain startup output for renderer initialization without unbounded growth.
    this.output = (this.output + data).slice(-256_000)
    this.onData(data)
  }

  private report(message: string): void {
    this.emit(`${this.output ? '\r\n' : ''}[startCommand] ${message}\r\n`)
  }

  private async run(): Promise<void> {
    const { signal } = this.controller
    while (!signal.aborted) {
      try {
        this.report(`Running: ${this.command}`)
        this.current = this.factory.start(
          this.command,
          this.cols,
          this.rows,
          (data) => this.emit(data),
        )
        const { exitCode, signal: exitSignal } = await this.current.exited
        await this.stopping
        this.report(
          exitSignal
            ? `Exited with signal ${exitSignal}.`
            : `Exited with code ${exitCode}.`,
        )
      } catch (error) {
        log.error({ err: error }, 'Failed to run desktop startCommand')
        this.report(
          error instanceof Error ? error.message : 'Unable to start command.',
        )
      } finally {
        this.current = undefined
        this.stopping = undefined
      }
      if (signal.aborted) break
      this.report('Restarting shortly…')
      await timers
        .setTimeout(1000, undefined, { signal })
        .catch((error: unknown) => {
          if (!signal.aborted) throw error
        })
    }
  }
}
