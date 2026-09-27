import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import {
  COMPANION_PROTOCOL_VERSION,
  DEFAULT_COMPANION_URL,
  MAX_MESSAGE_BYTES,
  MAX_SERVER_MESSAGE_BYTES,
  normalizeCompanionUrl,
  parseServerMessage,
  type ClientMessage,
  type CompanionStatus,
  type PingResult,
  type ResponseMessage,
  type WorktreeSnapshot,
  type WorktreeUpdate,
  type CreateWorktreeInput,
  type DeleteWorktreeInput,
  createWorktreeInputSchema,
  deleteWorktreeInputSchema,
  openEditorInputSchema,
  setWorktreeErrorInputSchema,
  type SetWorktreeErrorInput,
  type OpenEditorInput,
  type EditorSession,
} from '../shared/companion.ts'

interface ClientOptions {
  url?: string
  token?: string
  requestTimeoutMs?: number
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
  heartbeatIntervalMs?: number
}

interface PendingRequest {
  resolve: (result: ResponseMessage) => void
  reject: (error: Error) => void
  expected: ResponseMessage['type']
}

export class CompanionClient extends EventEmitter<{
  status: [CompanionStatus]
  worktreesUpdated: [WorktreeUpdate]
  chatActivate: [{ id: string; input: OpenEditorInput }]
  chatFinished: [string]
}> {
  private status: CompanionStatus
  private readonly options: ClientOptions
  private socket?: WebSocket
  private running = false
  private attempts = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private helloTimer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private readonly pending = new Map<string, PendingRequest>()

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

  chatViewReady(
    id: string,
    error?: string,
    activationAfter: string | null = null,
  ): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({
          type: 'chat:view-ready',
          id,
          error: error?.slice(0, 1024),
          activationAfter,
        } satisfies ClientMessage),
      )
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

  async ping(): Promise<PingResult> {
    const startedAt = performance.now()
    await this.request({ type: 'ping', id: randomUUID() })
    return { roundTripMs: Math.round(performance.now() - startedAt) }
  }

  listWorktrees(): Promise<WorktreeSnapshot> {
    return this.worktreeRequest({ type: 'worktrees:list', id: randomUUID() })
  }

  async openEditor(
    input: OpenEditorInput,
    signal?: AbortSignal,
  ): Promise<EditorSession> {
    const parsed = openEditorInputSchema.safeParse(input)
    if (!parsed.success) throw new Error('Invalid editor worktree.')
    const response = await this.request(
      {
        type: 'editor:open',
        id: randomUUID(),
        input: parsed.data,
      },
      signal,
    )
    if (response.type !== 'editor')
      throw new Error('Unexpected editor response.')
    return response.session
  }

  refreshWorktrees(): Promise<WorktreeSnapshot> {
    return this.worktreeRequest({ type: 'worktrees:refresh', id: randomUUID() })
  }

  createWorktree(input: CreateWorktreeInput): Promise<WorktreeSnapshot> {
    const parsed = createWorktreeInputSchema.safeParse(input)
    if (!parsed.success)
      return Promise.reject(new Error('Invalid worktree creation fields.'))
    return this.worktreeRequest({
      type: 'worktrees:create',
      id: randomUUID(),
      input: parsed.data,
    })
  }

  deleteWorktree(input: DeleteWorktreeInput): Promise<WorktreeSnapshot> {
    const parsed = deleteWorktreeInputSchema.safeParse(input)
    if (!parsed.success)
      return Promise.reject(new Error('Invalid worktree deletion fields.'))
    return this.worktreeRequest({
      type: 'worktrees:delete',
      id: randomUUID(),
      input: parsed.data,
    })
  }

  setWorktreeError(input: SetWorktreeErrorInput): Promise<WorktreeSnapshot> {
    return this.worktreeRequest({
      type: 'worktrees:set-error',
      id: randomUUID(),
      input: setWorktreeErrorInputSchema.parse(input),
    })
  }

  private async worktreeRequest(
    message: ClientMessage,
  ): Promise<WorktreeSnapshot> {
    const response = await this.request(message)
    if (response.type !== 'worktrees')
      throw new Error('Unexpected worktree response.')
    return response.snapshot
  }

  private request(
    message: ClientMessage,
    signal?: AbortSignal,
  ): Promise<ResponseMessage> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const socket = this.socket
    if (
      this.status.state !== 'connected' ||
      socket?.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(new Error('Connect to the companion server first.'))
    }
    if (this.pending.size >= 32)
      return Promise.reject(new Error('Too many pending requests.'))
    const payload = JSON.stringify(message)
    if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES)
      return Promise.reject(new Error('Request exceeds the 16 KiB limit.'))
    const id = message.id
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout)
        this.pending.delete(id)
        signal?.removeEventListener('abort', abort)
      }
      const fail = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const abort = (): void => fail(signal!.reason)
      const timeout = setTimeout(
        () => {
          fail(
            new Error(
              message.type === 'ping'
                ? 'Companion ping timed out.'
                : message.type === 'editor:open'
                  ? 'Editor startup timed out. Try opening the worktree again.'
                  : 'Worktree request timed out. Refresh to check the result before retrying.',
            ),
          )
        },
        this.options.requestTimeoutMs ??
          (message.type === 'editor:open'
            ? 180_000
            : message.type === 'ping' || message.type === 'worktrees:list'
              ? 5_000
              : 120_000),
      )
      this.pending.set(id, {
        resolve: (response) => {
          cleanup()
          resolve(response)
        },
        reject: fail,
        expected:
          message.type === 'ping'
            ? 'pong'
            : message.type === 'editor:open'
              ? 'editor'
              : 'worktrees',
      })
      signal?.addEventListener('abort', abort, { once: true })
      socket.send(payload, (error) => {
        if (!error) return
        const request = this.pending.get(id)
        if (!request) return
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
        maxPayload: MAX_SERVER_MESSAGE_BYTES,
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
      } else if (message.type === 'worktrees:updated') {
        this.emit('worktreesUpdated', {
          change: message.change,
          snapshot: message.snapshot,
        })
      } else if (message.type === 'chat:activate') {
        this.emit('chatActivate', { id: message.id, input: message.input })
      } else if (message.type === 'chat:finished') {
        this.emit('chatFinished', message.id)
      } else if (
        message.type === 'pong' ||
        message.type === 'editor' ||
        message.type === 'worktrees' ||
        (message.type === 'error' && message.id)
      ) {
        if (!message.id) return
        const request = this.pending.get(message.id)
        if (!request) return
        if (message.type === 'error') request.reject(new Error(message.message))
        else if (message.type !== request.expected)
          request.reject(new Error('Unexpected companion response.'))
        else request.resolve(message)
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
