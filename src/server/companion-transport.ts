import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Server as Engine } from 'engine.io'
import { Server, type Socket } from 'socket.io'
import type { Logger } from 'pino'
import {
  COMPANION_PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  companionRequests,
  companionEvents,
  type WorktreeSnapshot,
} from '../shared/companion.ts'
import {
  handleRpc,
  listenEvent,
  sendEvent,
  type requestSpec,
} from '../shared/rpc.ts'
import type { WorktreeStore } from './worktrees/worktree-store.ts'
import type { Chat } from '../shared/chats.ts'
import type { ChatService } from './chats/chat-service.ts'
import { authorized, rejectUpgrade } from './transport.ts'

interface CompanionTransportOptions {
  worktrees: WorktreeStore
  chats: ChatService
  logger: Logger
  token?: string
  heartbeatIntervalMs?: number
}

export function createCompanionTransport(options: CompanionTransportOptions) {
  const { worktrees, chats, logger } = options
  let closing: Promise<void> | undefined
  const interval = options.heartbeatIntervalMs ?? 30_000
  const engine = new Engine({
    transports: ['websocket'],
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    pingInterval: interval,
    pingTimeout: interval,
  })
  const sockets = new Server({ serveClient: false }).bind(engine)
  const upgrades = new Set<Duplex>()
  let chatRequest: { id: string; owner: Socket } | undefined
  chats.onNavigate = (id, input) => {
    const clients = [...sockets.sockets.sockets.values()]
    if (clients.length !== 1)
      throw new Error(
        clients.length
          ? 'Chat navigation requires exactly one connected desktop.'
          : 'No desktop is connected.',
      )
    chatRequest = { id, owner: clients[0] }
    sendEvent(clients[0], companionEvents.activateChat, { id, input })
  }
  chats.onNavigationFinished = (id) => {
    if (chatRequest?.id !== id) return
    const { owner } = chatRequest
    chatRequest = undefined
    sendEvent(owner, companionEvents.finishChat, id)
  }
  const broadcast = (snapshot: WorktreeSnapshot) => {
    for (const client of sockets.sockets.sockets.values())
      sendEvent(client, companionEvents.worktrees, snapshot)
  }
  const notifyIdle = (chat: Chat) => {
    for (const client of sockets.sockets.sockets.values())
      sendEvent(client, companionEvents.chatIdle, chat)
  }
  chats.store.on('idle', notifyIdle)
  worktrees.on('update', broadcast)
  sockets.on('connection', (client) => {
    logger.info('Companion client connected')
    const events = new Set([
      ...Object.values(companionRequests).map((spec) => spec.event),
      companionEvents.viewReady.event,
    ])
    client.onAny((event: string, ...args: unknown[]) => {
      const acknowledge = args.at(-1)
      if (!events.has(event) && typeof acknowledge === 'function')
        acknowledge({ ok: false, error: 'Unsupported companion command.' })
    })
    client.on('disconnect', (reason) => {
      if (chatRequest?.owner === client)
        chats.viewReady(chatRequest.id, 'Desktop disconnected. Try again.')
      logger.info({ reason }, 'Companion client disconnected')
    })
    listenEvent(
      client,
      companionEvents.viewReady,
      (message) => {
        if (chatRequest?.id === message.id && chatRequest.owner === client)
          chats.viewReady(message.id, message.error, message.activationAfter)
      },
      () => client.conn.close(),
    )
    const register = <I, O>(
      spec: ReturnType<typeof requestSpec<I, O>>,
      handler: (input: I) => O | Promise<O>,
    ) => {
      handleRpc(
        client,
        spec,
        (input) => {
          if (closing) throw new Error('Companion is stopping.')
          logger.info(
            { command: spec.event, clientId: client.id },
            'Command received',
          )
          return handler(input)
        },
        (elapsedMs, error, result) => {
          const details = {
            command: spec.event,
            clientId: client.id,
            elapsedMs,
            ...(result && typeof result === 'object' && 'id' in result
              ? { editorId: result.id }
              : {}),
          }
          if (error) logger.error({ ...details, err: error }, 'Command failed')
          else
            logger.info(
              details,
              spec.event === 'editor:open'
                ? 'Editor ready'
                : spec.event === 'worktrees:create' ||
                    spec.event === 'worktrees:delete'
                  ? 'Command accepted'
                  : 'Command completed',
            )
        },
      )
    }
    register(companionRequests.activateChat, (id) => chats.activate(id, client))
    register(companionRequests.pasteTarget, (id) => chats.pasteTarget(id))
    register(companionRequests.list, () => worktrees.list())
    register(companionRequests.refresh, () => worktrees.refresh())
    register(companionRequests.create, (input) => worktrees.startCreate(input))
    register(companionRequests.delete, (input) => worktrees.startDelete(input))
    register(companionRequests.setError, (input) => worktrees.setError(input))
    register(companionRequests.openEditor, (input) =>
      worktrees.openEditor(input),
    )
    sendEvent(client, companionEvents.hello, {
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    })
  })
  return {
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ): void {
      const status = closing
        ? '503 Service Unavailable'
        : request.headers.origin !== undefined
          ? '403 Forbidden'
          : options.token &&
              !authorized(request.headers.authorization, options.token)
            ? '401 Unauthorized'
            : null
      if (status) return rejectUpgrade(socket, status)
      upgrades.add(socket)
      socket.once('close', () => upgrades.delete(socket))
      engine.handleUpgrade(request, socket, head)
    },
    close(): Promise<void> {
      closing ??= (async () => {
        worktrees.off('update', broadcast)
        chats.store.off('idle', notifyIdle)
        if (chatRequest)
          chats.viewReady(chatRequest.id, 'Companion is stopping.')
        chatRequest = undefined
        chats.onNavigate = undefined
        chats.onNavigationFinished = undefined
        // Shutdown must not wait for peers to answer a WebSocket close frame.
        for (const socket of upgrades) socket.destroy()
        upgrades.clear()
        await sockets.close()
      })()
      return closing
    },
  }
}
