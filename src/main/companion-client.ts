import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import {
  COMPANION_PROTOCOL_VERSION,
  DEFAULT_COMPANION_URL,
  MAX_MESSAGE_BYTES,
  normalizeCompanionUrl,
  parseServerMessage,
  type ClientMessage,
  type CompanionStatus,
  type PingResult,
} from '../shared/companion.ts'

interface ClientOptions {
  url?: string
  token?: string
  requestTimeoutMs?: number
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
  heartbeatIntervalMs?: number
}

interface PendingPing {
  resolve: (result: PingResult) => void
  reject: (error: Error) => void
  startedAt: number
  timeout: ReturnType<typeof setTimeout>
}

export class CompanionClient extends EventEmitter<{
  status: [CompanionStatus]
}> {
  private status: CompanionStatus
  private readonly options: ClientOptions
  private socket?: WebSocket
  private running = false
  private attempts = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private helloTimer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private readonly pending = new Map<string, PendingPing>()

  constructor(options: ClientOptions = {}) {
    super()
    this.options = options
    this.status = {
      state: 'disconnected',
      url: options.url ?? DEFAULT_COMPANION_URL,
    }
  }

  getStatus(): CompanionStatus {
    return { ...this.status }
  }

  connect(): CompanionStatus {
    this.stop()
    this.running = true
    this.attempts = 0
    this.open()
    return this.getStatus()
  }

  // Only application shutdown stops automatic connection attempts.
  stop(): CompanionStatus {
    this.running = false
    clearTimeout(this.retryTimer)
    this.clearConnection(new Error('Disconnected from companion server.'))
    const socket = this.socket
    this.socket = undefined
    socket?.terminate()
    this.update({ state: 'disconnected', url: this.status.url })
    return this.getStatus()
  }

  ping(): Promise<PingResult> {
    const socket = this.socket
    if (
      this.status.state !== 'connected' ||
      socket?.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(new Error('Connect to the companion server first.'))
    }
    if (this.pending.size >= 32)
      return Promise.reject(new Error('Too many pending requests.'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Companion ping timed out.'))
      }, this.options.requestTimeoutMs ?? 5_000)
      this.pending.set(id, {
        resolve,
        reject,
        timeout,
        startedAt: performance.now(),
      })
      const message: ClientMessage = { type: 'ping', id }
      socket.send(JSON.stringify(message), (error) => {
        if (!error) return
        const request = this.pending.get(id)
        if (!request) return
        clearTimeout(request.timeout)
        this.pending.delete(id)
        request.reject(error)
      })
    })
  }

  private update(status: CompanionStatus): void {
    this.status = status
    this.emit('status', this.getStatus())
  }

  private clearConnection(error: Error): void {
    clearTimeout(this.helloTimer)
    clearInterval(this.heartbeat)
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
  }

  private open(): void {
    if (!this.running) return
    this.update({
      state: this.attempts ? 'reconnecting' : 'connecting',
      url: this.status.url,
      error: this.status.error,
    })
    let socket: WebSocket
    try {
      socket = new WebSocket(normalizeCompanionUrl(this.status.url), {
        handshakeTimeout: this.options.requestTimeoutMs ?? 5_000,
        maxPayload: MAX_MESSAGE_BYTES,
        headers: this.options.token
          ? { Authorization: `Bearer ${this.options.token}` }
          : undefined,
      })
    } catch (error) {
      this.retry(error instanceof Error ? error.message : String(error))
      return
    }
    this.socket = socket
    let lastError = 'Connection to companion server closed.'
    let welcomed = false
    let awaitingPong = false
    const fail = (message: string): void => {
      lastError = message
      socket.terminate()
    }

    socket.on('open', () => {
      if (this.socket !== socket) return
      this.helloTimer = setTimeout(
        () => fail('Companion handshake timed out.'),
        this.options.requestTimeoutMs ?? 5_000,
      )
    })
    socket.on('message', (data, isBinary) => {
      if (this.socket !== socket) return
      const message = isBinary ? null : parseServerMessage(data.toString())
      if (!message) return fail('Invalid message from companion server.')
      if (message.type === 'hello') {
        if (
          welcomed ||
          message.protocolVersion !== COMPANION_PROTOCOL_VERSION
        ) {
          return fail(
            'Incompatible companion protocol version or duplicate handshake.',
          )
        }
        welcomed = true
        clearTimeout(this.helloTimer)
        this.attempts = 0
        this.heartbeat = setInterval(() => {
          if (awaitingPong) return fail('Companion heartbeat timed out.')
          awaitingPong = true
          socket.ping()
        }, this.options.heartbeatIntervalMs ?? 10_000)
        this.update({
          state: 'connected',
          url: this.status.url,
        })
      } else if (!welcomed) {
        fail('Companion server did not send a handshake.')
      } else if (message.type === 'pong') {
        const request = this.pending.get(message.id)
        if (!request) return
        clearTimeout(request.timeout)
        this.pending.delete(message.id)
        request.resolve({
          roundTripMs: Math.round(performance.now() - request.startedAt),
        })
      } else {
        fail(message.message)
      }
    })
    socket.on('pong', () => {
      awaitingPong = false
    })
    socket.on('error', (error) => {
      lastError = error.message
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.retry(lastError)
    })
  }

  private retry(error: string): void {
    this.clearConnection(new Error(error))
    if (!this.running) return
    this.update({ state: 'reconnecting', url: this.status.url, error })
    const delay = Math.min(
      (this.options.reconnectDelayMs ?? 500) *
        2 ** Math.min(this.attempts++, 10),
      this.options.maxReconnectDelayMs ?? 10_000,
    )
    this.retryTimer = setTimeout(() => this.open(), delay)
  }
}
