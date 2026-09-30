import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Server as Engine } from 'engine.io'
import getRawBody from 'raw-body'
import { Server as SocketServer, type Socket } from 'socket.io'
import { editorDataDir } from '../config.ts'
import { chatProvider, type ChatProvider } from './chat-providers.ts'
import type { PasteTarget } from '../../shared/paste-schema.ts'
import { materializePaste } from './chat-paste.ts'
import type { PastePart } from '../../shared/paste.ts'
import { callRpc, handleRpc, listenEvent, sendEvent } from '../../shared/rpc.ts'
import { z } from 'zod'
import type { Logger } from 'pino'
import type { OpenEditorInput } from '../../shared/companion.ts'
import {
  chatReportSchema,
  chatRequests,
  chatEvents,
} from '../../shared/chats.ts'
import { ChatStore } from './chat-store.ts'
import { silentLogger } from '../logging.ts'
import { authorized, rejectUpgrade } from '../transport.ts'

interface EditorRegistration {
  activityEnvironment: NodeJS.ProcessEnv
  controlToken: string
}

interface EditorConnection {
  id: string
  worktree: OpenEditorInput
  extensionToken: string
  activityToken: string
  activation?: string
  startedAt: number
  socket?: Socket
}
interface Navigation {
  id: string
  source: Socket
  complete: (error?: string) => void
  editorId: string
  terminalId: string
  timer: ReturnType<typeof setTimeout>
  ready: boolean
  activationAfter?: string | null
  target?: Socket
}
const handshakeSchema = z.object({
  activation: z.uuid(),
  startedAt: z.coerce.number().finite().nonnegative(),
})
interface PasteReservation {
  editorId: string
  documentId: string
  owner: Socket
  socket: Socket
  target: PasteTarget
  provider: ChatProvider
  expires: number
}

export class ChatService {
  readonly store: ChatStore
  private readonly editors = new Map<string, EditorConnection>()
  private navigation?: Navigation
  private readonly engine = new Engine({
    transports: ['websocket'],
    maxHttpBufferSize: 128 * 1024,
    pingInterval: 9000,
    pingTimeout: 9000,
  })
  private readonly sockets = new SocketServer({ serveClient: false }).bind(
    this.engine,
  )
  private readonly upgrades = new Set<Duplex>()
  private closing = false
  private readonly pastes = new Set<Promise<null>>()
  private readonly pasteReservations = new Map<string, PasteReservation>()
  private readonly pendingReservations = new Map<Socket, number>()
  private readonly pasteQueues = new Map<string, Promise<void>>()
  private readonly server: Server
  private timer?: ReturnType<typeof setInterval>
  private titleTimer?: ReturnType<typeof setInterval>
  private endpoint = ''
  private reconciling = false
  onNavigate?: (id: string, worktree: OpenEditorInput) => void
  onNavigationFinished?: (id: string) => void

  private readonly logger: Logger
  private readonly pasteDirectory: string
  constructor(
    logger: Logger = silentLogger,
    store = new ChatStore(),
    pasteDirectory = editorDataDir(),
  ) {
    this.pasteDirectory = pasteDirectory
    this.logger = logger
    this.store = store
    this.server = createServer((request, response) => {
      const scope = [...this.editors.values()].find((entry) =>
        authorized(request.headers.authorization, entry.activityToken),
      )
      if (
        request.url !== '/activity' ||
        request.method !== 'POST' ||
        request.headers.origin !== undefined ||
        !scope
      ) {
        response.writeHead(403).end()
        return
      }
      request.setTimeout(2000, () => request.destroy())
      void (async () => {
        const body = await getRawBody(request, {
          limit: 64 * 1024,
          encoding: 'utf8',
        })
        const report = chatReportSchema.parse(JSON.parse(body))
        const accepted = await this.store.activity(
          scope.id,
          scope.worktree,
          report,
        )
        response.writeHead(accepted ? 204 : 409).end()
      })().catch((error: unknown) => {
        if (response.destroyed) return
        response.once('finish', () => request.destroy())
        response.setHeader('Connection', 'close')
        const tooLarge =
          error instanceof Error &&
          'type' in error &&
          error.type === 'entity.too.large'
        if (!response.headersSent) response.writeHead(tooLarge ? 413 : 400)
        response.end()
      })
    })
    this.server.on('upgrade', (request, socket, head) => {
      socket.on('error', () => socket.destroy())
      let url: URL
      try {
        url = new URL(request.url ?? '/', 'http://localhost')
      } catch {
        socket.destroy()
        return
      }
      const scope = [...this.editors.values()].find((entry) =>
        authorized(request.headers.authorization, entry.extensionToken),
      )
      const identity = handshakeSchema.safeParse(
        Object.fromEntries(url.searchParams),
      ).data
      if (
        url.pathname !== '/extension' ||
        request.headers.origin !== undefined ||
        !scope ||
        !identity ||
        identity.startedAt < scope.startedAt ||
        (identity.startedAt === scope.startedAt &&
          scope.activation !== identity.activation)
      ) {
        rejectUpgrade(socket, '403 Forbidden')
        return
      }
      if (this.closing) return rejectUpgrade(socket, '503 Service Unavailable')
      this.upgrades.add(socket)
      socket.once('close', () => this.upgrades.delete(socket))
      this.engine.handleUpgrade(request, socket, head)
    })
    this.sockets.on('connection', (client) => {
      const url = new URL(client.request.url!, 'http://localhost')
      const identity = handshakeSchema.parse(
        Object.fromEntries(url.searchParams),
      )
      const scope = [...this.editors.values()].find((entry) =>
        authorized(client.request.headers.authorization, entry.extensionToken),
      )
      if (
        !scope ||
        this.closing ||
        identity.startedAt < scope.startedAt ||
        (identity.startedAt === scope.startedAt &&
          identity.activation !== scope.activation)
      ) {
        client.conn.close()
        return
      }
      const previous = scope.socket
      scope.activation = identity.activation
      scope.startedAt = identity.startedAt
      scope.socket = client
      previous?.conn.close()
      client.on('disconnect', () => {
        if (scope.socket === client) scope.socket = undefined
        const navigation = this.navigation
        if (navigation?.source === client || navigation?.target === client)
          this.finish(navigation.id, 'Editor connection closed. Try again.')
      })
      handleRpc(client, chatRequests.activate, (chatId) => {
        if (scope.socket !== client || this.closing)
          throw new Error('Editor connection is no longer current.')
        return this.activate(chatId, client)
      })
      listenEvent(
        client,
        chatEvents.focused,
        (message) => {
          if (scope.socket !== client) return
          const navigation = this.navigation
          if (navigation?.id === message.id && navigation.target === client)
            this.finish(message.id, message.error)
        },
        () => client.conn.close(),
      )
      sendEvent(client, chatEvents.snapshot, this.store.list())
      if (this.navigation?.editorId === scope.id) this.focus(this.navigation.id)
    })
    this.store.on('update', (snapshot) => {
      for (const scope of this.editors.values())
        if (scope.socket) sendEvent(scope.socket, chatEvents.snapshot, snapshot)
    })
  }

  forgetPastes(owner: Socket): void {
    for (const [id, reservation] of this.pasteReservations)
      if (reservation.owner === owner) this.pasteReservations.delete(id)
  }

  async reservePaste(
    owner: Socket,
    editorId: string,
    documentId: string,
  ): Promise<string | null> {
    for (const [id, reservation] of this.pasteReservations)
      if (
        reservation.expires <= Date.now() ||
        !reservation.owner.connected ||
        this.editors.get(reservation.editorId)?.socket !== reservation.socket
      )
        this.pasteReservations.delete(id)
    const pending = this.pendingReservations.get(owner) ?? 0
    const reserved = [...this.pasteReservations.values()].filter(
      (reservation) => reservation.owner === owner,
    ).length
    if (pending + reserved >= 32) throw new Error('Too many pending pastes.')
    const socket = this.editors.get(editorId)?.socket
    if (this.closing || !owner.connected || !socket?.connected)
      throw new Error(
        'The editor extension is disconnected. Try pasting again.',
      )
    this.pendingReservations.set(owner, pending + 1)
    try {
      const target = await callRpc(socket, chatRequests.pasteTarget, null)
      if (
        this.closing ||
        !owner.connected ||
        this.editors.get(editorId)?.socket !== socket
      )
        throw new Error('The editor connection changed. Try pasting again.')
      if (!target) return null
      const provider = chatProvider(target.provider)
      if (!provider) throw new Error('Unsupported chat provider.')
      const id = randomUUID()
      this.pasteReservations.set(id, {
        editorId,
        documentId,
        owner,
        socket,
        target,
        provider,
        expires: Date.now() + 30_000,
      })
      return id
    } finally {
      const remaining = (this.pendingReservations.get(owner) ?? 1) - 1
      if (remaining) this.pendingReservations.set(owner, remaining)
      else this.pendingReservations.delete(owner)
    }
  }

  async paste(
    owner: Socket,
    editorId: string,
    documentId: string,
    reservationId: string,
    items: PastePart[],
  ): Promise<null> {
    const reservation = this.pasteReservations.get(reservationId)
    if (
      !reservation ||
      reservation.owner !== owner ||
      reservation.editorId !== editorId ||
      reservation.documentId !== documentId ||
      reservation.expires <= Date.now()
    )
      throw new Error('The paste reservation is invalid or expired.')
    this.pasteReservations.delete(reservationId)
    const key = JSON.stringify([editorId, reservation.target.terminalId])
    const previous = this.pasteQueues.get(key) ?? Promise.resolve()
    const request = this.deliverPaste(reservation, items, previous)
    const tail = Promise.allSettled([previous, request]).then(() => {})
    this.pasteQueues.set(key, tail)
    void tail.then(() => {
      if (this.pasteQueues.get(key) === tail) this.pasteQueues.delete(key)
    })
    this.pastes.add(request)
    void request.finally(() => this.pastes.delete(request)).catch(() => {})
    return request
  }

  private async deliverPaste(
    reservation: PasteReservation,
    items: PastePart[],
    previous: Promise<void>,
  ): Promise<null> {
    const { owner, socket, editorId, target, provider } = reservation
    const assertCurrent = () => {
      if (
        this.closing ||
        !owner.connected ||
        !socket.connected ||
        this.editors.get(editorId)?.socket !== socket
      )
        throw new Error('The editor connection changed. Try pasting again.')
    }
    assertCurrent()
    // Terminal identity and provider come from the extension, before any CLI
    // lifecycle hook runs. Activity tracking must never be a prerequisite to paste.
    const parts = await materializePaste(items, this.pasteDirectory)
    const text = provider.preparePaste(parts)
    await previous
    assertCurrent()
    return callRpc(socket, chatRequests.paste, { ...target, text })
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    this.timer = setInterval(() => {
      if (this.reconciling) return
      this.reconciling = true
      void this.store
        .reconcile()
        .catch((error: unknown) =>
          this.logger.warn({ err: error }, 'Chat reconciliation failed'),
        )
        .finally(() => {
          this.reconciling = false
        })
    }, 3000)
    this.timer.unref()
    this.titleTimer = setInterval(() => {
      void this.store.refreshTitles()
    }, 60_000)
    this.titleTimer.unref()
  }

  registerEditor(id: string, worktree: OpenEditorInput): EditorRegistration {
    this.releaseEditor(id)
    const entry: EditorConnection = {
      id,
      worktree,
      extensionToken: randomBytes(32).toString('hex'),
      activityToken: randomBytes(32).toString('hex'),
      startedAt: -1,
    }
    this.editors.set(id, entry)
    return {
      activityEnvironment: {
        ADE_CHAT_ENDPOINT: this.endpoint,
        ADE_CHAT_ACTIVITY_TOKEN: entry.activityToken,
      },
      controlToken: entry.extensionToken,
    }
  }

  activation(id: string): string | null {
    return this.editors.get(id)?.activation ?? null
  }

  releaseEditor(id: string): void {
    this.editors.get(id)?.socket?.conn.close()
    this.editors.delete(id)
    // Chat removal still belongs exclusively to process reconciliation.
  }

  activate(chatId: string, source: Socket): Promise<null> {
    if (this.closing) throw new Error('Companion is stopping.')
    if (this.navigation)
      this.finish(this.navigation.id, 'Superseded by another navigation.')
    const entry = this.store.get(chatId)
    if (!entry) throw new Error('This chat is no longer available.')
    return new Promise<null>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(
        () =>
          this.finish(
            id,
            'The destination terminal did not become ready. Try again.',
          ),
        30_000,
      )
      this.navigation = {
        id,
        source,
        complete: (error) => (error ? reject(new Error(error)) : resolve(null)),
        editorId: entry.editorId,
        terminalId: entry.chat.terminalId,
        timer,
        ready: false,
      }
      try {
        if (!this.onNavigate) throw new Error('No desktop is connected.')
        this.onNavigate(id, entry.worktree)
      } catch (error) {
        this.finish(
          id,
          error instanceof Error ? error.message : 'Could not select desktop.',
        )
      }
    })
  }

  viewReady(
    id: string,
    error?: string,
    activationAfter: string | null = null,
  ): void {
    if (error) {
      this.finish(id, error)
      return
    }
    const navigation = this.navigation
    if (navigation?.id !== id || navigation.ready) return
    navigation.ready = true
    navigation.activationAfter = activationAfter
    this.focus(id)
  }

  private focus(id: string): void {
    const navigation = this.navigation
    if (navigation?.id !== id) return
    const scope = this.editors.get(navigation.editorId)
    const socket = scope?.socket
    if (!navigation.ready || navigation.target || !socket?.connected) return
    if (scope?.activation === navigation.activationAfter) return
    navigation.target = socket
    sendEvent(socket, chatEvents.focus, {
      id,
      terminalId: navigation.terminalId,
    })
  }

  private finish(id: string, error?: string): void {
    const navigation = this.navigation
    if (navigation?.id !== id) return
    clearTimeout(navigation.timer)
    this.navigation = undefined
    this.onNavigationFinished?.(id)
    if (error && navigation.target)
      sendEvent(navigation.target, chatEvents.cancelFocus, id)
    navigation.complete(error?.slice(0, 1024))
  }

  async close(): Promise<void> {
    this.closing = true
    this.pasteReservations.clear()
    clearInterval(this.timer)
    clearInterval(this.titleTimer)
    const titlesClosed = this.store.close()
    if (this.navigation)
      this.finish(this.navigation.id, 'Companion is stopping.')
    // Include peers that have not finished their Socket.IO handshake.
    for (const socket of this.upgrades) socket.destroy()
    this.upgrades.clear()
    await this.sockets.close()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
    await Promise.allSettled(this.pastes)
    await titlesClosed
  }
}
