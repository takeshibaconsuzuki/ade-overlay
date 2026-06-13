import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { createSseStream } from '../sse'
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

type WorktreeRouteOptions = {
  beforeDeleteWorktree?: (worktreeId: string) => Promise<void>
}

export function registerWorktreeRoutes(
  server: FastifyInstance,
  registry: WorktreeRegistry,
  options: WorktreeRouteOptions = {},
): void {
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
    handler: async (request) => {
      const worktree = await registry.getWorktreeById(request.params.worktreeId)
      if (worktree.path !== worktree.mainWorktreePath) {
        await options.beforeDeleteWorktree?.(request.params.worktreeId)
      }
      return registry.deleteWorktree(
        request.params.worktreeId,
        request.body.deleteBranch,
      )
    },
  })
}

async function streamWorktreeEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  registry: WorktreeRegistry,
): Promise<void> {
  const stream = createSseStream(request, reply)
  const onWorktreeEvent = (event: WorktreeEvent): void => {
    stream.send(event.type, event)
  }

  registry.events.on('worktree-event', onWorktreeEvent)
  stream.onClose(() => {
    registry.events.off('worktree-event', onWorktreeEvent)
  })

  stream.send('snapshot', await registry.getSnapshot())
}
