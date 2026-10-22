import { fork, type ChildProcess } from 'node:child_process'
import treeKill from 'tree-kill'
import { logger } from '../shared/logger'

export interface TerminalProcess {
  readonly exited: Promise<{ exitCode: number; signal?: number }>
  write(data: string): void
  resize(cols: number, rows: number): void
  stop(): Promise<void>
}

export interface TerminalProcessFactory {
  start(
    command: string,
    cols: number,
    rows: number,
    onData: (data: string) => void,
  ): TerminalProcess
}

export type TerminalHostRequest =
  | { type: 'start'; command: string; cols: number; rows: number }
  | { type: 'write'; data: string }
  | { type: 'resize'; cols: number; rows: number }

export type TerminalHostEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number }

const log = logger.child({ component: 'desktop-terminal-host' })

export class NodeTerminalProcessFactory implements TerminalProcessFactory {
  constructor(private readonly entry: string) {}

  start(
    command: string,
    cols: number,
    rows: number,
    onData: (data: string) => void,
  ): TerminalProcess {
    return new NodeTerminalProcess(this.entry, command, cols, rows, onData)
  }
}

class NodeTerminalProcess implements TerminalProcess {
  readonly exited: TerminalProcess['exited']
  private readonly child: ChildProcess
  private closed = false
  private stopping: Promise<void> | undefined

  constructor(
    entry: string,
    command: string,
    cols: number,
    rows: number,
    onData: (data: string) => void,
  ) {
    this.child = fork(entry, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    })
    let result: Awaited<TerminalProcess['exited']> | undefined
    this.child.on('message', (event: TerminalHostEvent) => {
      if (event.type === 'data') onData(event.data)
      else result = { exitCode: event.exitCode, signal: event.signal }
    })
    this.child.on('error', (error) => {
      log.error({ err: error }, 'Desktop terminal host failed')
    })
    // Resolve only after the host has exited, so replacements cannot accumulate
    // workers or native handles from prior commands. IPC preserves final output.
    this.exited = new Promise((resolve) => {
      this.child.once('close', (code) => {
        this.closed = true
        resolve(result ?? { exitCode: code ?? 1 })
      })
    })
    this.send({ type: 'start', command, cols, rows })
  }

  write(data: string): void {
    this.send({ type: 'write', data })
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows })
  }

  private send(message: TerminalHostRequest): void {
    if (!this.child.connected) return
    this.child.send(message, (error) => {
      // The host may finish between checking connected and sending a request.
      if (
        error &&
        !['ERR_IPC_CHANNEL_CLOSED', 'EPIPE', 'ENOTCONN'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        log.warn({ err: error }, 'Unable to send terminal request')
    })
  }

  stop(): Promise<void> {
    this.stopping ??= this.terminate().catch((error: unknown) => {
      this.stopping = undefined
      throw error
    })
    return this.stopping
  }

  private async terminate(): Promise<void> {
    if (!this.closed && this.child.pid) {
      await new Promise<void>((resolve, reject) => {
        treeKill(this.child.pid!, 'SIGKILL', (error) => {
          if (error && !this.closed) reject(error)
          else resolve()
        })
      })
    }
    await this.exited
  }
}
