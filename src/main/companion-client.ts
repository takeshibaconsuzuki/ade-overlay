import type { PastePart } from '../shared/paste.ts'
import { EventEmitter } from 'node:events'
import type { Socket } from 'socket.io-client'
import type { Chat } from '../shared/chats.ts'
import type { CompanionStatus } from '../shared/ipc.ts'
import {
  COMPANION_PROTOCOL_VERSION,
  DEFAULT_COMPANION_URL,
  companionRequests,
  companionEvents,
  type WorktreeSnapshot,
  type WorktreeBranch,
  type CreateWorktreeInput,
  type WorktreePathTemplates,
  type DeleteWorktreeInput,
  type SetWorktreeErrorInput,
  type WorktreeRef,
  type EditorServerSession,
} from '../shared/companion.ts'
import {
  callRpc,
  listenEvent,
  sendEvent,
  type requestSpec,
} from '../shared/rpc.ts'
import { createSocket } from '../shared/node/socket-client.ts'

interface ClientOptions {
  url?: string
  token?: string
  requestTimeoutMs?: number
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
}

export class CompanionClient extends EventEmitter<{
  status: [CompanionStatus]
  desktopUpdateWorktrees: [WorktreeSnapshot]
  desktopOpenChat: [{ id: string; input: WorktreeRef }]
  desktopFinishOpenChat: [string]
  desktopNotifyChatIdle: [Chat]
}> {
  private status: CompanionStatus
  private readonly options: ClientOptions
  private socket?: Socket
  private helloTimer?: ReturnType<typeof setTimeout>

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

  desktopOpenChatResponse(
    id: string,
    error?: string,
    activationAfter: string | null = null,
  ): void {
    if (this.socket)
      sendEvent(this.socket, companionEvents.desktopOpenChatResponse, {
        id,
        error: error?.slice(0, 1024),
        activationAfter,
      })
  }

  connect(): void {
    this.stop()
    const socket = createSocket(this.status.url, {
      token: this.options.token,
      timeout: this.options.requestTimeoutMs,
      reconnectDelay: this.options.reconnectDelayMs,
      maxReconnectDelay: this.options.maxReconnectDelayMs,
    })
    this.socket = socket
    this.update({ state: 'connecting', url: this.status.url })
    let welcomed = false
    let failure: string | undefined
    const fail = (error: string) => {
      failure = error
      socket.io.engine.close()
    }
    const invalid = () => fail('Invalid message from companion server.')
    socket.on('connect', () => {
      if (this.socket !== socket) return
      this.helloTimer = setTimeout(
        () => fail('Companion handshake timed out.'),
        this.options.requestTimeoutMs ?? 5000,
      )
    })
    listenEvent(
      socket,
      companionEvents.hello,
      ({ protocolVersion }) => {
        if (this.socket !== socket) return
        if (welcomed || protocolVersion !== COMPANION_PROTOCOL_VERSION)
          return fail(
            'Incompatible companion protocol version or duplicate handshake.',
          )
        welcomed = true
        failure = undefined
        clearTimeout(this.helloTimer)
        this.update({ state: 'connected', url: this.status.url })
      },
      invalid,
    )
    const receive = <T>(
      spec: Parameters<typeof listenEvent<T>>[1],
      listener: (value: T) => void,
    ) =>
      listenEvent(
        socket,
        spec,
        (value) => {
          if (this.socket !== socket) return
          if (!welcomed)
            return fail('Companion server did not send a handshake.')
          listener(value)
        },
        invalid,
      )
    receive(companionEvents.desktopUpdateWorktrees, (value) =>
      this.emit('desktopUpdateWorktrees', value),
    )
    receive(companionEvents.desktopNotifyChatIdle, (chat) =>
      this.emit('desktopNotifyChatIdle', chat),
    )
    receive(companionEvents.desktopOpenChat, (value) =>
      this.emit('desktopOpenChat', value),
    )
    receive(companionEvents.desktopFinishOpenChat, (id) =>
      this.emit('desktopFinishOpenChat', id),
    )
    socket.on('connect_error', (error) => {
      if (this.socket === socket)
        this.update({
          state: 'reconnecting',
          url: this.status.url,
          error: error.message,
        })
    })
    socket.on('disconnect', (reason) => {
      if (this.socket !== socket) return
      clearTimeout(this.helloTimer)
      welcomed = false
      this.update({
        state: 'reconnecting',
        url: this.status.url,
        error: failure ?? reason,
      })
    })
    socket.connect()
  }

  stop(): void {
    clearTimeout(this.helloTimer)
    const socket = this.socket
    this.socket = undefined
    socket?.disconnect()
    this.update({ state: 'disconnected', url: this.status.url })
  }

  companionReservePaste(
    editorServerId: string,
    documentId: string,
  ): Promise<string | null> {
    return this.request(companionRequests.companionReservePaste, {
      editorServerId,
      documentId,
    })
  }

  companionPaste(
    editorServerId: string,
    documentId: string,
    reservationId: string,
    items: PastePart[],
  ): Promise<null> {
    return this.request(companionRequests.companionPaste, {
      editorServerId,
      documentId,
      reservationId,
      items,
    })
  }

  companionOpenChat(id: string): Promise<null> {
    return this.request(companionRequests.companionOpenChat, id)
  }

  companionOpenBootstrapLog(input: WorktreeRef): Promise<null> {
    return this.request(companionRequests.companionOpenBootstrapLog, input)
  }
  companionListWorktrees(): Promise<WorktreeSnapshot> {
    return this.request(companionRequests.companionListWorktrees, null)
  }
  companionRefreshWorktrees(): Promise<WorktreeSnapshot> {
    return this.request(companionRequests.companionRefreshWorktrees, null)
  }
  companionCreateWorktree(
    input: CreateWorktreeInput,
  ): Promise<WorktreeSnapshot> {
    return this.request(companionRequests.companionCreateWorktree, input)
  }
  companionGetPathTemplates(): Promise<WorktreePathTemplates> {
    return this.request(companionRequests.companionGetPathTemplates, null)
  }
  companionListBranches(project: string): Promise<WorktreeBranch[]> {
    return this.request(companionRequests.companionListBranches, { project })
  }
  companionDeleteWorktree(
    input: DeleteWorktreeInput,
  ): Promise<WorktreeSnapshot> {
    return this.request(companionRequests.companionDeleteWorktree, input)
  }
  companionSetWorktreeError(
    input: SetWorktreeErrorInput,
  ): Promise<WorktreeSnapshot> {
    return this.request(companionRequests.companionSetWorktreeError, input)
  }
  companionStopEditorServer(input: WorktreeRef): Promise<WorktreeSnapshot> {
    return this.request(companionRequests.companionStopEditorServer, input)
  }
  companionStartEditorServer(
    input: WorktreeRef,
    signal?: AbortSignal,
  ): Promise<EditorServerSession> {
    return this.request(
      companionRequests.companionStartEditorServer,
      input,
      signal,
    )
  }

  private async request<I, O>(
    spec: ReturnType<typeof requestSpec<I, O>>,
    input: I,
    signal?: AbortSignal,
  ): Promise<O> {
    signal?.throwIfAborted()
    if (!this.socket || this.status.state !== 'connected')
      throw new Error('Connect to the companion server first.')
    try {
      return await callRpc(this.socket, spec, input, {
        signal,
        timeout: this.options.requestTimeoutMs,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'operation has timed out')
        throw new Error(
          spec.event === 'companionStartEditorServer'
            ? 'Editor startup timed out. Try opening the worktree again.'
            : spec.event === 'desktopOpenChat'
              ? 'Chat navigation timed out. Try opening the chat again.'
              : 'Worktree request timed out. Refresh to check the result before retrying.',
          { cause: error },
        )
      throw error
    }
  }
  private update(status: CompanionStatus): void {
    this.status = status
    this.emit('status', this.getStatus())
  }
}
