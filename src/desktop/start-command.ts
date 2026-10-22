import { spawn, type ChildProcess } from 'node:child_process'
import treeKill from 'tree-kill'
import { logger } from '../shared/logger'

const log = logger.child({ component: 'desktop-start-command' })

// Commands stay in the foreground so their process trees remain owned by the desktop.
export class DesktopStartCommand {
  readonly started: Promise<void>
  readonly exited: Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>
  private readonly child: ChildProcess
  private closed = false
  private stopping: Promise<void> | undefined

  constructor(command: string) {
    this.child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    this.started = new Promise((resolve, reject) => {
      this.child.once('spawn', resolve)
      this.child.once('error', (error) => {
        reject(
          new Error('Failed to run desktop startCommand', { cause: error }),
        )
      })
    })
    this.exited = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.closed = true
        if (!this.stopping) {
          if (code === 0) log.info('Desktop startCommand exited')
          else log.error({ code, signal }, 'Desktop startCommand failed')
        }
        resolve({ code, signal })
      })
    })
  }

  // Concurrent stops share one attempt; a failed termination can be retried.
  stop(): Promise<void> {
    this.stopping ??= this.terminate().catch((error: unknown) => {
      this.stopping = undefined
      throw error
    })
    return this.stopping
  }

  private async terminate(): Promise<void> {
    const pid = this.child.pid
    if (!this.closed && pid) {
      await new Promise<void>((resolve, reject) => {
        treeKill(pid, 'SIGKILL', (error) => {
          if (error && !this.closed) reject(error)
          else resolve()
        })
      })
    }
    await this.exited
  }
}
