import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { platform } from 'node:os'
import { type IPty, type spawn as PtySpawn } from 'node-pty'
import { type WebSocket } from 'ws'
import {
  type ChatTerminalClientMessage,
  type ChatTerminalServerMessage,
  type ChatTerminalStatus,
} from '../../api/server/chats'
import { type Logger } from '../../api/server/logger'
import { getUserLoginShell } from '../userShell'
import { type ChatTerminal } from './schemas'

/**
 * How much recent PTY output to retain per terminal so a reconnecting renderer
 * (the chat window was closed and reopened) can replay the screen. Sized large
 * enough that a full session's scrollback survives a reconnect; older bytes are
 * still dropped from the front as a backstop so memory stays bounded.
 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * `node-pty` is a native addon rebuilt for Electron's ABI; loading it under a
 * plain Node process (e.g. the client generator, which imports the server) would
 * fail. Resolve it lazily on first terminal spawn so merely importing this
 * module never touches the native binary.
 */
let ptySpawn: typeof PtySpawn | null = null
function loadPtySpawn(): typeof PtySpawn {
  if (!ptySpawn) {
    const require = createRequire(import.meta.url)
    ptySpawn = (require('node-pty') as { spawn: typeof PtySpawn }).spawn
  }
  return ptySpawn
}

type TerminalRecord = {
  id: string
  worktreeId: string
  providerId: string
  sessionId?: string
  title?: string
  status: ChatTerminalStatus
  exitCode: number | null
  pty: IPty
  // Bounded ring buffer of recent output, replayed to a (re)attaching socket.
  buffer: string[]
  bufferBytes: number
  // At most one renderer views a terminal at a time; a fresh attach replaces it.
  socket: WebSocket | null
}

export type CreateTerminalOptions = {
  worktreeId: string
  providerId: string
  sessionId?: string
  title?: string
  cwd: string
  command: string
  args: string[]
}

/**
 * Owns the live PTYs running chat sessions. PTYs live here in the server (not
 * the chat window), so terminals survive the chat app being closed; the chat
 * renderer attaches/detaches over a WebSocket and replays the output buffer on
 * reconnect.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>()

  constructor(private readonly log: Logger) {}

  create(options: CreateTerminalOptions): ChatTerminal {
    const id = randomUUID()
    const target = withUserEnvironment(options.command, options.args)
    const pty = loadPtySpawn()(target.file, target.args, {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    })

    const record: TerminalRecord = {
      id,
      worktreeId: options.worktreeId,
      providerId: options.providerId,
      sessionId: options.sessionId,
      title: options.title,
      status: 'running',
      exitCode: null,
      pty,
      buffer: [],
      bufferBytes: 0,
      socket: null,
    }
    this.terminals.set(id, record)

    pty.onData((data) => {
      this.appendBuffer(record, data)
      send(record.socket, { type: 'output', data })
    })
    pty.onExit(({ exitCode }) => {
      record.status = 'exited'
      record.exitCode = exitCode
      send(record.socket, { type: 'exit', code: exitCode })
      // Drop the record: an exited chat session can't be resumed in place, so
      // it should not linger in the terminal list or be reattachable. The
      // renderer closes the tab when it sees the `exit` message.
      this.terminals.delete(id)
      this.log.info(
        { terminalId: id, worktreeId: record.worktreeId, exitCode },
        'chat terminal exited',
      )
    })

    this.log.info(
      {
        terminalId: id,
        worktreeId: options.worktreeId,
        providerId: options.providerId,
        command: options.command,
        resume: !!options.sessionId,
      },
      'chat terminal started',
    )
    return toDescriptor(record)
  }

  /**
   * Attach a renderer WebSocket to a terminal: replay the buffered output, then
   * stream live I/O. A new attach supersedes any previous viewer.
   */
  attach(terminalId: string, socket: WebSocket): void {
    const record = this.terminals.get(terminalId)
    if (!record) {
      // Unknown/closed terminal: tell the client it's gone and close.
      send(socket, { type: 'exit', code: null })
      socket.close()
      return
    }

    // Replace any prior viewer so only one socket receives output.
    const superseded = !!record.socket && record.socket !== socket
    if (superseded) {
      record.socket?.close()
    }
    record.socket = socket
    this.log.info(
      { terminalId, superseded, status: record.status },
      'chat terminal socket attached',
    )

    if (record.buffer.length > 0) {
      send(socket, { type: 'output', data: record.buffer.join('') })
    }
    if (record.status === 'exited') {
      send(socket, { type: 'exit', code: record.exitCode })
    }

    socket.on('message', (raw: Buffer) => {
      const message = parseClientMessage(raw)
      if (!message) {
        return
      }
      if (message.type === 'ping') {
        send(socket, { type: 'pong' })
      } else if (message.type === 'input') {
        record.pty.write(message.data)
      } else if (message.type === 'resize') {
        try {
          record.pty.resize(
            Math.max(1, Math.floor(message.cols)),
            Math.max(1, Math.floor(message.rows)),
          )
        } catch (error) {
          this.log.warn(
            { err: error, terminalId },
            'chat terminal resize failed',
          )
        }
      }
    })

    socket.on('close', () => {
      if (record.socket === socket) {
        record.socket = null
        this.log.info({ terminalId }, 'chat terminal socket detached')
      }
    })
    socket.on('error', (error) => {
      if (record.socket === socket) {
        record.socket = null
      }
      this.log.warn({ err: error, terminalId }, 'chat terminal socket error')
    })
  }

  list(worktreeId?: string): ChatTerminal[] {
    return [...this.terminals.values()]
      .filter((record) => !worktreeId || record.worktreeId === worktreeId)
      .map(toDescriptor)
  }

  close(terminalId: string): void {
    const record = this.terminals.get(terminalId)
    if (!record) {
      return
    }
    this.terminals.delete(terminalId)
    record.socket?.close()
    this.killPty(record)
  }

  closeForWorktree(worktreeId: string): void {
    for (const record of [...this.terminals.values()]) {
      if (record.worktreeId === worktreeId) {
        this.close(record.id)
      }
    }
  }

  shutdown(): void {
    for (const record of [...this.terminals.values()]) {
      record.socket?.close()
      this.killPty(record)
    }
    this.terminals.clear()
  }

  private appendBuffer(record: TerminalRecord, data: string): void {
    record.buffer.push(data)
    record.bufferBytes += Buffer.byteLength(data)
    while (record.bufferBytes > MAX_BUFFER_BYTES && record.buffer.length > 1) {
      const dropped = record.buffer.shift()
      if (dropped !== undefined) {
        record.bufferBytes -= Buffer.byteLength(dropped)
      }
    }
  }

  private killPty(record: TerminalRecord): void {
    if (record.status === 'exited') {
      return
    }
    try {
      record.pty.kill()
    } catch (error) {
      this.log.warn(
        { err: error, terminalId: record.id },
        'chat terminal kill failed',
      )
    }
  }
}

/**
 * Resolve how to actually spawn a chat command so it runs with the user's real
 * environment.
 *
 * A packaged app launched from the macOS Finder/Dock inherits only a minimal
 * `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so the chat CLIs — `claude` in
 * `~/.local/bin`, `codex` in `/opt/homebrew/bin`, etc. — aren't on it and the
 * PTY exits instantly (the chat never starts; in dev it works only because the
 * terminal that ran `npm run dev` already exported the right `PATH`). Running
 * through a login+interactive shell sources the user's profile so those CLIs
 * resolve, exactly as worktree bootstrap commands do. `exec` replaces the shell
 * with the CLI so it becomes the PTY's controlling process — input, resize, and
 * exit all behave as if it were spawned directly. On Windows there is no such
 * `PATH` stripping, so spawn the command directly.
 */
function withUserEnvironment(
  command: string,
  args: string[],
): { file: string; args: string[] } {
  if (platform() === 'win32') {
    return { file: command, args }
  }
  const shell = getUserLoginShell()
  if (!shell) {
    return { file: command, args }
  }
  const line = [command, ...args].map(shellQuote).join(' ')
  return { file: shell, args: ['-lic', `exec ${line}`] }
}

/**
 * POSIX single-quote a token: wrap in single quotes, breaking out around any
 * embedded single quote. Safe for interpolating session ids / paths into the
 * `exec` line above.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function toDescriptor(record: TerminalRecord): ChatTerminal {
  return {
    terminalId: record.id,
    worktreeId: record.worktreeId,
    providerId: record.providerId,
    sessionId: record.sessionId,
    title: record.title,
    status: record.status,
  }
}

function send(
  socket: WebSocket | null,
  message: ChatTerminalServerMessage,
): void {
  if (!socket || socket.readyState !== socket.OPEN) {
    return
  }
  socket.send(JSON.stringify(message))
}

function parseClientMessage(raw: Buffer): ChatTerminalClientMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const message = parsed as Record<string, unknown>
  if (message.type === 'ping') {
    return { type: 'ping' }
  }
  if (message.type === 'input' && typeof message.data === 'string') {
    return { type: 'input', data: message.data }
  }
  if (
    message.type === 'resize' &&
    typeof message.cols === 'number' &&
    typeof message.rows === 'number'
  ) {
    return { type: 'resize', cols: message.cols, rows: message.rows }
  }
  return null
}
