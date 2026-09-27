import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import type { Logger } from 'pino'
import type { OpenEditorInput } from '../shared/companion.ts'
import {
  chatReportSchema,
  extensionChatMessageSchema,
  type ServerChatMessage,
} from '../shared/chats.ts'
import { ChatStore } from './chats.ts'
import { silentLogger } from './logging.ts'

interface EditorConnection {
  id: string
  worktree: OpenEditorInput
  extensionToken: string
  activityToken: string
  activation?: string
  startedAt: number
  socket?: WebSocket
  terminals?: Set<string>
}
interface Navigation {
  source: WebSocket
  sourceId: string
  editorId: string
  terminalId: string
  timer: ReturnType<typeof setTimeout>
  ready: boolean
  activationAfter?: string | null
  target?: WebSocket
}
const handshakeSchema = z.object({
  activation: z.uuid(),
  startedAt: z.coerce.number().finite().nonnegative(),
})
function authorized(value: string | undefined, token: string): boolean {
  const actual = Buffer.from(value ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export class ChatService {
  readonly store: ChatStore
  private readonly editors = new Map<string, EditorConnection>()
  private readonly navigations = new Map<string, Navigation>()
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
  })
  private readonly server: Server
  private timer?: ReturnType<typeof setInterval>
  private endpoint = ''
  private reconciling = false
  private readonly alive = new Set<WebSocket>()
  onNavigate?: (id: string, worktree: OpenEditorInput) => void
  onNavigationFinished?: (id: string) => void

  private readonly logger: Logger
  constructor(logger: Logger = silentLogger, store = new ChatStore()) {
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
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of request) {
          length += chunk.length
          if (length > 64 * 1024) {
            response.writeHead(413).end()
            return
          }
          chunks.push(chunk)
        }
        const report = chatReportSchema.parse(
          JSON.parse(Buffer.concat(chunks, length).toString('utf8')),
        )
        const accepted = await this.store.activity(scope.id, report)
        response.writeHead(accepted ? 204 : 409).end()
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400)
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
        socket.end(
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          () => socket.destroy(),
        )
        return
      }
      this.sockets.handleUpgrade(request, socket, head, (client) => {
        const previous = scope.socket
        scope.activation = identity.activation
        scope.startedAt = identity.startedAt
        scope.socket = client
        scope.terminals = undefined
        previous?.terminate()
        this.alive.add(client)
        client.on('pong', () => this.alive.add(client))
        client.on('error', () => client.terminate())
        client.on('close', () => {
          this.alive.delete(client)
          if (scope.socket === client) scope.socket = undefined
          for (const [id, navigation] of this.navigations)
            if (navigation.source === client || navigation.target === client)
              this.finish(id, 'Editor connection closed. Try again.')
        })
        client.on('message', (data, binary) => {
          if (scope.socket !== client || binary) return
          let input: unknown
          try {
            input = JSON.parse(data.toString())
          } catch {
            client.close(1008)
            return
          }
          const message = extensionChatMessageSchema.safeParse(input).data
          if (!message) {
            client.close(1008)
            return
          }
          if (message.type === 'inventory') {
            void this.store
              .inventory(scope.id, scope.worktree, message.terminals)
              .then((terminals) => {
                if (scope.socket !== client) return
                scope.terminals = new Set(
                  terminals.map((item) => item.terminalId),
                )
                this.send(client, { type: 'result', id: message.id, terminals })
                for (const [id, navigation] of this.navigations)
                  if (
                    navigation.editorId === scope.id &&
                    terminals.some(
                      (item) => item.terminalId === navigation.terminalId,
                    )
                  )
                    this.focus(id)
              })
              .catch(() =>
                this.send(client, {
                  type: 'result',
                  id: message.id,
                  error: 'Could not inspect terminal processes. Try again.',
                }),
              )
          } else if (message.type === 'activate')
            this.activate(client, message.id, message.chatId)
          else {
            const navigation = this.navigations.get(message.id)
            if (navigation?.target === client)
              this.finish(message.id, message.error)
          }
        })
        this.send(client, { type: 'snapshot', snapshot: this.store.list() })
      })
    })
    this.store.on('update', (snapshot) => {
      for (const scope of this.editors.values())
        if (scope.socket)
          this.send(scope.socket, { type: 'snapshot', snapshot })
    })
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
    let ticks = 0
    this.timer = setInterval(() => {
      if (++ticks % 3 === 0)
        for (const client of this.sockets.clients) {
          if (!this.alive.delete(client)) client.terminate()
          else client.ping()
        }
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
  }

  environment(id: string, worktree: OpenEditorInput): NodeJS.ProcessEnv {
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
      ADE_CHAT_ENDPOINT: this.endpoint,
      ADE_CHAT_ACTIVITY_TOKEN: entry.activityToken,
    }
  }

  extensionToken(id: string): string | undefined {
    return this.editors.get(id)?.extensionToken
  }

  activation(id: string): string | null {
    return this.editors.get(id)?.activation ?? null
  }

  releaseEditor(id: string): void {
    this.editors.get(id)?.socket?.terminate()
    this.editors.delete(id)
    // Chat removal still belongs exclusively to process reconciliation.
  }

  private activate(source: WebSocket, sourceId: string, chatId: string): void {
    for (const id of this.navigations.keys())
      this.finish(id, 'Superseded by another navigation.')
    const entry = this.store.get(chatId)
    if (!entry) {
      this.send(source, {
        type: 'result',
        id: sourceId,
        error: 'This chat is no longer available.',
      })
      return
    }
    const id = randomUUID()
    const timer = setTimeout(
      () =>
        this.finish(
          id,
          'The destination terminal did not become ready. Try again.',
        ),
      30_000,
    )
    this.navigations.set(id, {
      source,
      sourceId,
      editorId: entry.editorId,
      terminalId: entry.chat.terminalId,
      timer,
      ready: false,
    })
    try {
      if (!this.onNavigate) throw new Error('No desktop is connected.')
      this.onNavigate(id, {
        project: entry.chat.project,
        path: entry.chat.path,
      })
    } catch (error) {
      this.finish(
        id,
        error instanceof Error ? error.message : 'Could not select desktop.',
      )
    }
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
    const navigation = this.navigations.get(id)
    if (!navigation || navigation.ready) return
    navigation.ready = true
    navigation.activationAfter = activationAfter
    this.focus(id)
  }

  private focus(id: string): void {
    const navigation = this.navigations.get(id)
    const scope = navigation && this.editors.get(navigation.editorId)
    const socket = scope?.socket
    if (
      !navigation?.ready ||
      navigation.target ||
      socket?.readyState !== WebSocket.OPEN
    )
      return
    if (
      !scope?.terminals?.has(navigation.terminalId) ||
      scope.activation === navigation.activationAfter
    )
      return
    navigation.target = socket
    this.send(socket, { type: 'focus', id, terminalId: navigation.terminalId })
  }

  private finish(id: string, error?: string): void {
    const navigation = this.navigations.get(id)
    if (!navigation) return
    clearTimeout(navigation.timer)
    this.navigations.delete(id)
    this.onNavigationFinished?.(id)
    if (error && navigation.target)
      this.send(navigation.target, { type: 'cancel-focus', id })
    this.send(navigation.source, {
      type: 'result',
      id: navigation.sourceId,
      error: error?.slice(0, 1024),
    })
  }

  private send(socket: WebSocket, message: ServerChatMessage): void {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message))
  }

  async close(): Promise<void> {
    clearInterval(this.timer)
    for (const id of this.navigations.keys())
      this.finish(id, 'Companion is stopping.')
    for (const socket of this.sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()))
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
    await this.store.settled()
  }
}
