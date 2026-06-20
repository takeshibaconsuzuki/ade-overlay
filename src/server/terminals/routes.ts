import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import { WebSocketServer } from 'ws'
import {
  parseTerminalSocketUrl,
  Terminal,
  TERMINAL_STREAM_PATH,
  TerminalCreateRequest,
  TERMINALS_PATH,
  TerminalSseEvents,
  TerminalStreamResponse,
  type TerminalSnapshot,
} from '../../api/server/terminals'
import { type ChatService } from '../chats/service'
import { createSseStream } from '../sse'
import { type TerminalService } from './service'

export function registerTerminalRoutes(
  server: FastifyInstance,
  terminals: TerminalService,
  chat: ChatService,
): void {
  const routes = server.withTypeProvider<ZodTypeProvider>()

  routes.route({
    method: 'GET',
    url: TERMINAL_STREAM_PATH,
    schema: {
      operationId: 'terminalEvents',
      response: {
        200: TerminalStreamResponse,
      },
    },
    handler: async (request, reply) => {
      streamTerminalEvents(request, reply, terminals)
    },
  })

  routes.route({
    method: 'POST',
    url: TERMINALS_PATH,
    schema: {
      operationId: 'createTerminal',
      body: TerminalCreateRequest,
      response: {
        200: Terminal,
      },
    },
    handler: async (request) =>
      chat.createTerminal({
        worktreeId: request.body.worktreeId,
        providerId: request.body.providerId,
        resumeChatId: request.body.resumeChatId,
        title: request.body.title,
      }),
  })

  registerTerminalSocket(server, terminals)
}

function streamTerminalEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  terminals: TerminalService,
): void {
  const stream = createSseStream<typeof TerminalSseEvents>(request, reply)
  const onSnapshot = (items: TerminalSnapshot['terminals']): void => {
    stream.send('snapshot', { terminals: items })
  }

  terminals.events.on('terminal-snapshot', onSnapshot)
  stream.onClose(() => {
    terminals.events.off('terminal-snapshot', onSnapshot)
  })

  stream.send('snapshot', { terminals: terminals.list() })
}

function registerTerminalSocket(
  server: FastifyInstance,
  terminals: TerminalService,
): void {
  const wss = new WebSocketServer({ noServer: true })

  server.server.on('upgrade', (request, socket, head) => {
    const target = parseTerminalSocketUrl(request.url)
    if (!target) {
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      terminals.attach(target.terminalId, ws, target.viewerId)
    })
  })

  server.addHook('onClose', async () => {
    wss.close()
  })
}
