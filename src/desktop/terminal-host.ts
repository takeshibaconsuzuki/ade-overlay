import { userInfo } from 'node:os'
import { spawn, type IPty } from 'node-pty'
import { logger } from '../shared/logger'
import type { TerminalHostEvent, TerminalHostRequest } from './terminal-process'

// This flag boots the helper as Node; commands must inherit the desktop's normal
// environment so Electron-based tools can still launch as applications.
delete process.env.ELECTRON_RUN_AS_NODE

const log = logger.child({ component: 'desktop-terminal' })
const windows = process.platform === 'win32'
let terminal: IPty | undefined
let resizeReady = !windows
let awaitingOutput = windows
let pendingSize: { cols: number; rows: number } | undefined

function send(message: TerminalHostEvent, done?: () => void): void {
  process.send!(message, (error) => {
    if (error) process.exit(1)
    done?.()
  })
}

// One command per host. Exiting releases native handles and node-pty workers,
// including workers that survive a silent command's normal exit on Windows.
function finish(event: { exitCode: number; signal?: number }): void {
  send({ type: 'exit', ...event }, () => process.exit(0))
}

function resize(cols: number, rows: number): void {
  if (!terminal) return
  if (!resizeReady) {
    pendingSize = { cols, rows }
    return
  }
  try {
    terminal.resize(cols, rows)
  } catch (error) {
    // Both platforms can report teardown before delivering onExit.
    if (
      error instanceof Error &&
      (error.message === 'ioctl(2) failed, EBADF' ||
        error.message === 'Cannot resize a pty that has already exited')
    )
      return
    log.warn({ err: error, cols, rows }, 'Unable to resize desktop terminal')
  }
}

process.on('message', (message: TerminalHostRequest) => {
  switch (message.type) {
    case 'start':
      if (terminal) return
      try {
        terminal = spawn(
          windows
            ? (process.env.ComSpec ?? 'cmd.exe')
            : process.env.SHELL || userInfo().shell || '/bin/sh',
          // cmd.exe must receive the command verbatim, including its own quoting.
          // Login/interactive startup files supply tools missing from a GUI app's PATH.
          windows ? `/d /s /c "${message.command}"` : ['-ilc', message.command],
          {
            name: 'xterm-256color',
            cols: message.cols,
            rows: message.rows,
            cwd: process.cwd(),
            env: process.env,
          },
        )
        terminal.onData((data) => {
          if (awaitingOutput) {
            awaitingOutput = false
            // Windows enables synchronous operations after the first onData
            // listeners. Apply our latest size afterward so resize errors stay
            // inside our handler, never in node-pty's deferred callback queue.
            queueMicrotask(() => {
              resizeReady = true
              const size = pendingSize
              pendingSize = undefined
              if (size) resize(size.cols, size.rows)
            })
          }
          send({ type: 'data', data })
        })
        terminal.onExit((event) => {
          terminal = undefined
          pendingSize = undefined
          finish(event)
        })
      } catch (error) {
        send({
          type: 'data',
          data: `\r\n${error instanceof Error ? error.message : 'Unable to start command.'}\r\n`,
        })
        finish({ exitCode: 1 })
      }
      break
    case 'write':
      terminal?.write(message.data)
      break
    case 'resize':
      resize(message.cols, message.rows)
      break
  }
})

process.once('disconnect', () => process.exit(1))
