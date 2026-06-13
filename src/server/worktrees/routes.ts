import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { WorktreeRegistry } from './registry'
import {
  AddRepositoryRequest,
  AddRepositoryResponse,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  DeleteWorktreeParams,
  DeleteWorktreeRequest,
  DeleteWorktreeResponse,
  ErrorResponse,
  RemoveRepositoryRequest,
  RemoveRepositoryResponse,
  type WorktreeEvent,
} from './schemas'

export function registerWorktreeRoutes(server: FastifyInstance): void {
  const registry = new WorktreeRegistry(
    server.log.child({ service: 'worktrees' }),
  )
  const routes = server.withTypeProvider<ZodTypeProvider>()

  routes.route({
    method: 'POST',
    url: '/repositories',
    schema: {
      operationId: 'addRepository',
      body: AddRepositoryRequest,
      response: {
        200: AddRepositoryResponse,
        400: ErrorResponse,
      },
    },
    handler: async (request) =>
      registry.addRepository(request.body.repositoryPath),
  })

  routes.route({
    method: 'DELETE',
    url: '/repositories',
    schema: {
      operationId: 'removeRepository',
      body: RemoveRepositoryRequest,
      response: {
        200: RemoveRepositoryResponse,
      },
    },
    handler: async (request) =>
      registry.removeRepository(request.body.mainWorktreePath),
  })

  routes.route({
    method: 'GET',
    url: '/worktrees',
    schema: {
      operationId: 'listWorktrees',
      response: {
        200: z
          .string()
          .describe('Server-sent worktree snapshot and change events.'),
      },
    },
    handler: async (request, reply) => {
      await streamWorktreeEvents(request, reply, registry)
    },
  })

  routes.route({
    method: 'POST',
    url: '/worktrees',
    schema: {
      operationId: 'createWorktree',
      body: CreateWorktreeRequest,
      response: {
        200: CreateWorktreeResponse,
        400: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (request) => registry.createWorktree(request.body),
  })

  routes.route({
    method: 'DELETE',
    url: '/worktrees/:worktreeId',
    schema: {
      operationId: 'deleteWorktree',
      params: DeleteWorktreeParams,
      body: DeleteWorktreeRequest,
      response: {
        200: DeleteWorktreeResponse,
        400: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (request) =>
      registry.deleteWorktree(
        request.params.worktreeId,
        request.body.deleteBranch,
      ),
  })
}

async function streamWorktreeEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  registry: WorktreeRegistry,
): Promise<void> {
  reply.hijack()

  // Hijacking detaches the reply from Fastify's hook pipeline, so `@fastify/cors`
  // never runs for this response. Reflect the request origin here (matching the
  // plugin's `origin: true` behavior) or the browser rejects the cross-origin
  // EventSource and it never leaves the CONNECTING state.
  const headers: Record<string, string> = {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
  }
  const { origin } = request.headers
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['vary'] = 'Origin'
  }
  reply.raw.writeHead(200, headers)

  const sendEvent = (eventName: string, data: unknown): void => {
    reply.raw.write(`event: ${eventName}\n`)
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  const onWorktreeEvent = (event: WorktreeEvent): void => {
    sendEvent(event.type, event)
  }
  const keepAlive = setInterval(() => {
    reply.raw.write(': keep-alive\n\n')
  }, 30_000)

  registry.events.on('worktree-event', onWorktreeEvent)
  reply.raw.on('close', () => {
    clearInterval(keepAlive)
    registry.events.off('worktree-event', onWorktreeEvent)
  })

  sendEvent('snapshot', await registry.getSnapshot())
}
