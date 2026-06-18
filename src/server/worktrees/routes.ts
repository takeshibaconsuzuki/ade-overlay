import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import {
  AddRepositoryRequest,
  AddRepositoryResponse,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  DeleteWorktreeParams,
  DeleteWorktreeRequest,
  DeleteWorktreeResponse,
  DismissCreationErrorResponse,
  ErrorResponse,
  ListBranchesRequest,
  ListBranchesResponse,
  OpenWorktreeRequest,
  OpenWorktreeResponse,
  PreviewWorktreePathRequest,
  PreviewWorktreePathResponse,
  RemoveRepositoryRequest,
  RemoveRepositoryResponse,
  REPOSITORIES_PATH,
  REPOSITORY_BRANCHES_PATH,
  WORKTREE_DISMISS_CREATION_PATH,
  WORKTREE_OPEN_PATH,
  WORKTREE_PATH,
  WORKTREE_PATH_PREVIEW_PATH,
  WorktreeIdParams,
  WORKTREES_PATH,
  WorktreeSseEvents,
  WorktreeStreamResponse,
  type WorktreeEvent,
} from '../../api/server/worktrees'
import { createSseStream } from '../sse'
import { type WorktreeOpener } from './opener'
import { WorktreeRegistry } from './registry'

type WorktreeRouteOptions = {
  opener: WorktreeOpener
  beforeDeleteWorktree?: (worktreeId: string) => Promise<void>
}

export function registerWorktreeRoutes(
  server: FastifyInstance,
  registry: WorktreeRegistry,
  options: WorktreeRouteOptions,
): void {
  const routes = server.withTypeProvider<ZodTypeProvider>()

  routes.route({
    method: 'POST',
    url: REPOSITORIES_PATH,
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
    url: REPOSITORIES_PATH,
    schema: {
      operationId: 'removeRepository',
      body: RemoveRepositoryRequest,
      response: {
        200: RemoveRepositoryResponse,
      },
    },
    handler: async (request) => {
      const worktrees = await registry.getRepositoryWorktrees(
        request.body.mainWorktreePath,
      )
      await Promise.all(
        worktrees.map((worktree) =>
          options.beforeDeleteWorktree?.(worktree.worktreeId),
        ),
      )
      return registry.removeRepository(request.body.mainWorktreePath)
    },
  })

  routes.route({
    method: 'GET',
    url: WORKTREES_PATH,
    schema: {
      operationId: 'listWorktrees',
      response: {
        200: WorktreeStreamResponse,
      },
    },
    handler: async (request, reply) => {
      await streamWorktreeEvents(request, reply, registry)
    },
  })

  routes.route({
    method: 'POST',
    url: WORKTREES_PATH,
    schema: {
      operationId: 'createWorktree',
      body: CreateWorktreeRequest,
      response: {
        200: CreateWorktreeResponse,
        400: ErrorResponse,
        404: ErrorResponse,
        409: ErrorResponse,
      },
    },
    handler: async (request) => registry.enqueueCreateWorktree(request.body),
  })

  routes.route({
    method: 'POST',
    url: WORKTREE_OPEN_PATH,
    schema: {
      operationId: 'openWorktree',
      params: OpenWorktreeRequest,
      response: {
        200: OpenWorktreeResponse,
        404: ErrorResponse,
        500: ErrorResponse,
      },
    },
    handler: async (request) =>
      options.opener.openWorktree(request.params.worktreeId),
  })

  routes.route({
    method: 'POST',
    url: WORKTREE_DISMISS_CREATION_PATH,
    schema: {
      operationId: 'dismissCreationError',
      params: WorktreeIdParams,
      response: {
        200: DismissCreationErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (request) =>
      registry.dismissCreationError(request.params.worktreeId),
  })

  routes.route({
    method: 'POST',
    url: REPOSITORY_BRANCHES_PATH,
    schema: {
      operationId: 'listBranches',
      body: ListBranchesRequest,
      response: {
        200: ListBranchesResponse,
        400: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (request) =>
      registry.listBranches(request.body.mainWorktreePath),
  })

  routes.route({
    method: 'POST',
    url: WORKTREE_PATH_PREVIEW_PATH,
    schema: {
      operationId: 'previewWorktreePath',
      body: PreviewWorktreePathRequest,
      response: {
        200: PreviewWorktreePathResponse,
        400: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (request) => registry.previewWorktreePath(request.body),
  })

  routes.route({
    method: 'DELETE',
    url: WORKTREE_PATH,
    schema: {
      operationId: 'deleteWorktree',
      params: DeleteWorktreeParams,
      body: DeleteWorktreeRequest,
      response: {
        200: DeleteWorktreeResponse,
        400: ErrorResponse,
        404: ErrorResponse,
        409: ErrorResponse,
      },
    },
    handler: async (request) => {
      const worktree = await registry.getWorktreeById(request.params.worktreeId)
      if (!worktree.isMain) {
        await options.beforeDeleteWorktree?.(request.params.worktreeId)
      }
      return registry.deleteWorktree(
        request.params.worktreeId,
        request.body.deleteBranch,
        request.body.force,
      )
    },
  })
}

async function streamWorktreeEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  registry: WorktreeRegistry,
): Promise<void> {
  const stream = createSseStream<typeof WorktreeSseEvents>(request, reply)
  const onWorktreeEvent = (event: WorktreeEvent): void => {
    stream.send(event.type, event)
  }

  // Log the listener count on every add/remove. This is the authoritative,
  // server-side ledger of worktree-event subscribers: renderer "closing stream"
  // logs are lost when a window tears down, so without this a leak (count climbs
  // and never drops) is invisible. A healthy session oscillates as windows open
  // and close; a steady climb toward WORKTREE_EVENT_MAX_LISTENERS is the tell.
  registry.events.on('worktree-event', onWorktreeEvent)
  request.log.info(
    { listeners: registry.events.listenerCount('worktree-event') },
    'worktree-event listener added',
  )
  stream.onClose(() => {
    registry.events.off('worktree-event', onWorktreeEvent)
    request.log.info(
      { listeners: registry.events.listenerCount('worktree-event') },
      'worktree-event listener removed',
    )
  })

  stream.send('snapshot', await registry.getSnapshot())
}
