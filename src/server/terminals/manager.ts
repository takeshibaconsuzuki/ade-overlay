import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { platform } from 'node:os'
import { type IPty, type spawn as PtySpawn } from 'node-pty'
import { type WebSocket } from 'ws'
import { type Logger } from '../../api/server/logger'
import {
  TerminalClientMessage,
  type Terminal,
  type TerminalServerMessage,
  type TerminalStatus,
} from '../../api/server/terminals'
import { getUserLoginShell } from '../userShell'

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
  title?: string
  status: TerminalStatus
  exitCode: number | null
  pty: IPty
  // Bounded ring buffer of recent output, replayed to a (re)attaching socket.
  buffer: string[]
  bufferBytes: number
  // At most one renderer views a terminal at a time; a fresh attach replaces it.
  socket: WebSocket | null
  // Identity of the currently-attached socket, so supersede/detach logs can name
  // exactly which connection was evicted. Paired 1:1 with `socket`.
  socketId: string | null
  // The renderer viewer (a single mounted Terminal component) that owns the
  // current socket. Sent by the renderer on the WS URL so both ends of a single
  // connection can be joined in a post-mortem.
  viewerId: string | null
}

export type CreateTerminalOptions = {
  worktreeId: string
  title?: string
  cwd: string
  command: string
  args: string[]
  preChatCommand?: string
  // Whether this resumes an existing chat (vs. a fresh one). Used only for
  // logging; a fresh chat may not know its chat id until the first hook arrives.
  resumed?: boolean
}

export type TerminalManagerChange =
  | { type: 'changed' }
  | {
      type: 'removed'
      reason: 'closed' | 'exited'
      terminal: Terminal
    }

/**
 * Owns the live PTYs running chat sessions. PTYs live here in the server (not
 * the chat window), so terminals survive the chat app being closed; the chat
 * renderer attaches/detaches over a WebSocket and replays the output buffer on
 * reconnect.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>()

  /**
   * @param onChange Invoked whenever the terminal set changes (created/exited/
   *   closed) so the owner can re-broadcast any state that joins against it.
   */
  constructor(
    private readonly log: Logger,
    private readonly onChange: (
      event: TerminalManagerChange,
    ) => void = () => {},
  ) {}

  terminalIdForHookProcess(
    worktreeId: string,
    hookAncestorPids: number[] | undefined,
  ): string | undefined {
    if (!hookAncestorPids || hookAncestorPids.length === 0) {
      return undefined
    }

    const ancestors = new Set(hookAncestorPids)
    const matches = [...this.terminals.values()].filter(
      (record) =>
        record.status === 'running' &&
        record.worktreeId === worktreeId &&
        ancestors.has(record.pty.pid),
    )
    return matches.length === 1 ? matches[0].id : undefined
  }

  create(options: CreateTerminalOptions): Terminal {
    const id = randomUUID()
    const target = resolveChatTerminalSpawn(
      options.command,
      options.args,
      options.preChatCommand,
    )
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
      title: options.title,
      status: 'running',
      exitCode: null,
      pty,
      buffer: [],
      bufferBytes: 0,
      socket: null,
      socketId: null,
      viewerId: null,
    }
    this.terminals.set(id, record)

    pty.onData((data) => {
      this.appendBuffer(record, data)
      send(record.socket, { type: 'output', data })
    })
    pty.onExit(({ exitCode }) => {
      record.status = 'exited'
      record.exitCode = exitCode
      const terminal = toDescriptor(record)
      send(record.socket, { type: 'exit', code: exitCode })
      // Drop the record: an exited chat session can't be resumed in place, so
      // it should not linger in the terminal list or be reattachable. The
      // renderer closes the tab when it sees the `exit` message.
      this.terminals.delete(id)
      this.log.info(
        { terminalId: id, worktreeId: record.worktreeId, exitCode },
        'chat terminal exited',
      )
      this.onChange({ type: 'removed', reason: 'exited', terminal })
    })

    this.log.info(
      {
        terminalId: id,
        worktreeId: options.worktreeId,
        command: options.command,
        hasPreChatCommand: !!options.preChatCommand,
        resume: options.resumed ?? false,
        ptyPid: pty.pid,
      },
      'chat terminal started',
    )
    this.onChange({ type: 'changed' })
    return toDescriptor(record)
  }

  /**
   * Attach a renderer WebSocket to a terminal: replay the buffered output, then
   * stream live I/O. A new attach supersedes any previous viewer.
   */
  attach(terminalId: string, socket: WebSocket, viewerId?: string): void {
    const socketId = randomUUID().slice(0, 8)
    const record = this.terminals.get(terminalId)
    if (!record) {
      // Unknown/closed terminal: tell the client it's gone and close.
      this.log.info(
        { terminalId, socketId, viewerId },
        'chat terminal socket attached to missing terminal',
      )
      send(socket, { type: 'exit', code: null })
      socket.close()
      return
    }

    // Replace any prior viewer so only one socket receives output. Capture the
    // evicted socket's identity first: a perpetual reconnect war shows up here as
    // two viewers repeatedly superseding each other, which is invisible unless
    // each eviction names exactly which socket/viewer it kicked.
    const superseded = !!record.socket && record.socket !== socket
    const supersededSocketId = superseded ? record.socketId : null
    const supersededViewerId = superseded ? record.viewerId : null
    if (superseded) {
      // Tell the evicted viewer it lost the terminal *before* closing, so it
      // stops instead of treating the close as a dropped connection and
      // reconnecting — which would supersede us right back, forever.
      send(record.socket, { type: 'superseded' })
      record.socket?.close()
    }
    record.socket = socket
    record.socketId = socketId
    record.viewerId = viewerId ?? null
    this.log.info(
      {
        terminalId,
        socketId,
        viewerId,
        superseded,
        supersededSocketId,
        supersededViewerId,
        status: record.status,
      },
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
      // Only the *current* owner clears the record: a superseded socket's close
      // fires after the slot was already handed to its replacement, so logging
      // `wasOwner:false` distinguishes "the viewer left" from "we evicted it".
      const wasOwner = record.socket === socket
      if (wasOwner) {
        record.socket = null
        record.socketId = null
        record.viewerId = null
      }
      this.log.info(
        { terminalId, socketId, viewerId, wasOwner },
        'chat terminal socket detached',
      )
    })
    socket.on('error', (error) => {
      if (record.socket === socket) {
        record.socket = null
        record.socketId = null
        record.viewerId = null
      }
      this.log.warn(
        { err: error, terminalId, socketId, viewerId },
        'chat terminal socket error',
      )
    })
  }

  list(worktreeId?: string): Terminal[] {
    return [...this.terminals.values()]
      .filter((record) => !worktreeId || record.worktreeId === worktreeId)
      .map(toDescriptor)
  }

  close(terminalId: string): void {
    const record = this.terminals.get(terminalId)
    if (!record) {
      return
    }
    const terminal = toDescriptor(record)
    this.terminals.delete(terminalId)
    record.socket?.close()
    this.killPty(record)
    this.onChange({ type: 'removed', reason: 'closed', terminal })
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
 * exit all behave as if it were spawned directly. On Windows node-pty has no
 * `shell: true`, so run through profile-loaded PowerShell for the same user
 * shell initialization model.
 */
export function resolveChatTerminalSpawn(
  command: string,
  args: string[],
  preChatCommand?: string,
): { file: string; args: string[] } {
  if (platform() === 'win32') {
    return windowsShellTarget(windowsScript(command, args, preChatCommand))
  }
  const shell = getUserLoginShell()
  if (!shell) {
    if (!preChatCommand) {
      return { file: command, args }
    }
    return {
      file: '/bin/sh',
      args: ['-c', shellScript(command, args, preChatCommand)],
    }
  }
  return {
    file: shell,
    args: ['-lic', shellScript(command, args, preChatCommand)],
  }
}

function windowsShellTarget(script: string): { file: string; args: string[] } {
  return {
    file: 'powershell.exe',
    // Do not pass -NoProfile: profile loading is the Windows equivalent of
    // macOS `shell -lic`, and is how user aliases/functions/PATH edits appear.
    args: ['-NoLogo', '-Command', windowsPowerShellScript(script)],
  }
}

function windowsPowerShellScript(commandScript: string): string {
  return `& {
${commandScript}
$__ade_success = $?
$__ade_status = $global:LASTEXITCODE
if ($null -ne $__ade_status) { exit $__ade_status }
if (-not $__ade_success) { exit 1 }
}`
}

function shellScript(
  command: string,
  args: string[],
  preChatCommand?: string,
): string {
  const line = [command, ...args].map(shellQuote).join(' ')
  if (!preChatCommand) {
    return `exec ${line}`
  }
  return `${preChatCommand}
__ade_pre_chat_status=$?
if [ "$__ade_pre_chat_status" -ne 0 ]; then
  exit "$__ade_pre_chat_status"
fi
exec ${line}`
}

function windowsScript(
  command: string,
  args: string[],
  preChatCommand?: string,
): string {
  const line = `$global:LASTEXITCODE = $null\r\n& ${[command, ...args].map(windowsPowerShellQuote).join(' ')}`
  if (!preChatCommand) {
    return line
  }
  return `${preChatCommand}\r\nif (-not $?) { exit 1 }\r\n${line}`
}

function windowsPowerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * POSIX single-quote a token: wrap in single quotes, breaking out around any
 * embedded single quote. Safe for interpolating session ids / paths into the
 * `exec` line above.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function toDescriptor(record: TerminalRecord): Terminal {
  return {
    terminalId: record.id,
    worktreeId: record.worktreeId,
    title: record.title,
    status: record.status,
  }
}

function send(socket: WebSocket | null, message: TerminalServerMessage): void {
  if (!socket || socket.readyState !== socket.OPEN) {
    return
  }
  socket.send(JSON.stringify(message))
}

function parseClientMessage(raw: Buffer): TerminalClientMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  const result = TerminalClientMessage.safeParse(parsed)
  return result.success ? result.data : null
}
