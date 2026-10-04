import { MAX_PASTE_MESSAGE_BYTES } from '../shared/paste-schema.ts'
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
    maxHttpBufferSize: MAX_PASTE_MESSAGE_BYTES,
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
    sendEvent(clients[0], companionEvents.desktopOpenChat, { id, input })
  }
  chats.onNavigationFinished = (id) => {
    if (chatRequest?.id !== id) return
    const { owner } = chatRequest
    chatRequest = undefined
    sendEvent(owner, companionEvents.desktopFinishOpenChat, id)
  }
  const broadcast = (snapshot: WorktreeSnapshot) => {
    for (const client of sockets.sockets.sockets.values())
      sendEvent(client, companionEvents.desktopUpdateWorktrees, snapshot)
  }
  const notifyIdle = (chat: Chat) => {
    for (const client of sockets.sockets.sockets.values())
      sendEvent(client, companionEvents.desktopNotifyChatIdle, chat)
  }
  chats.store.on('idle', notifyIdle)
  worktrees.on('update', broadcast)
  sockets.on('connection', (client) => {
    // Rich pastes carry binary images; all other commands retain the small
    // control-message limit even though the websocket admits larger frames.
    client.use(([event, input], next) => {
      if (
        event !== companionRequests.companionPaste.event &&
        Buffer.byteLength(JSON.stringify(input) ?? '') > MAX_MESSAGE_BYTES
      ) {
        client.conn.close()
        return
      }
      next()
    })
    logger.info('Companion client connected')
    const events = new Set([
      ...Object.values(companionRequests).map((spec) => spec.event),
      companionEvents.desktopOpenChatResponse.event,
    ])
    client.onAny((event: string, ...args: unknown[]) => {
      const acknowledge = args.at(-1)
      if (!events.has(event) && typeof acknowledge === 'function')
        acknowledge({ ok: false, error: 'Unsupported companion command.' })
    })
    client.on('disconnect', (reason) => {
      chats.forgetPastes(client)
      if (chatRequest?.owner === client)
        chats.viewReady(chatRequest.id, 'Desktop disconnected. Try again.')
      logger.info({ reason }, 'Companion client disconnected')
    })
    listenEvent(
      client,
      companionEvents.desktopOpenChatResponse,
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
              ? { editorServerId: result.id }
              : {}),
          }
          if (error) logger.error({ ...details, err: error }, 'Command failed')
          else
            logger.info(
              details,
              spec.event === 'companionStartEditorServer'
                ? 'Editor ready'
                : spec.event === 'companionCreateWorktree' ||
                    spec.event === 'companionDeleteWorktree'
                  ? 'Command accepted'
                  : 'Command completed',
            )
        },
      )
    }
    register(companionRequests.companionOpenChat, (id) =>
      chats.open(id, client),
    )
    register(
      companionRequests.companionPaste,
      ({ editorServerId, documentId, reservationId, items }) =>
        chats.paste(client, editorServerId, documentId, reservationId, items),
    )
    register(
      companionRequests.companionReservePaste,
      ({ editorServerId, documentId }) =>
        chats.reservePaste(client, editorServerId, documentId),
    )
    register(companionRequests.companionOpenBootstrapLog, async (input) => {
      const { editorServerId, path } = await worktrees.bootstrapLog(input)
      return chats.openFile(editorServerId, path)
    })
    register(companionRequests.companionListWorktrees, () => worktrees.list())
    register(companionRequests.companionGetPathTemplates, () =>
      worktrees.pathTemplates(),
    )
    register(companionRequests.companionListBranches, ({ project }) =>
      worktrees.branches(project),
    )
    register(companionRequests.companionRefreshWorktrees, () =>
      worktrees.refresh(),
    )
    register(companionRequests.companionCreateWorktree, (input) =>
      worktrees.startCreate(input),
    )
    register(companionRequests.companionDeleteWorktree, (input) =>
      worktrees.startDelete(input),
    )
    register(companionRequests.companionSetWorktreeError, (input) =>
      worktrees.setError(input),
    )
    register(companionRequests.companionStartEditorServer, (input) =>
      worktrees.startEditorServer(input),
    )
    register(companionRequests.companionStopEditorServer, (input) =>
      worktrees.stopEditorServer(input),
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
