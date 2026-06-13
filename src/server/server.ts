import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifySwagger from '@fastify/swagger'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { OPENAPI_PATH, SERVER_HOST, SERVER_PORT } from '../api/server/config'
import { HttpError, getStatusCode } from './errors'
import { logger } from './logger'
import { registerLogRoutes } from './logs/routes'
import { registerWorktreeRoutes } from './worktrees/routes'

export type ServerOptions = {
  host?: string
  port?: number
}

export function createServer() {
  const server = Fastify({ loggerInstance: logger })

  server.setValidatorCompiler(validatorCompiler)
  server.setSerializerCompiler(serializerCompiler)
  // The renderer is served from a different origin (Vite dev server or a
  // `file://` page), so allow cross-origin access to this local API.
  // `@fastify/cors` defaults to GET,HEAD,POST, which would block the DELETE
  // routes during preflight — list every method the API uses.
  server.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
  server.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'ADE Overlay API',
        version: '0.1.0',
      },
      servers: [],
    },
    transform: jsonSchemaTransform,
  })

  // Register routes after the Swagger plugin has booted so its `onRoute` hook
  // (installed during plugin load) captures them into the OpenAPI document.
  server.register(async (instance) => {
    registerWorktreeRoutes(instance)
    registerLogRoutes(instance)
  })

  server.get(OPENAPI_PATH, async () => server.swagger())

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({
        error: 'HTTP_ERROR',
        message: error.message,
      })
      return
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: 'REQUEST_VALIDATION_ERROR',
        message: error.message,
      })
      return
    }

    if (isResponseSerializationError(error)) {
      reply.status(500).send({
        error: 'RESPONSE_VALIDATION_ERROR',
        message: error.message,
      })
      return
    }

    const statusCode = getStatusCode(error)
    const message =
      error instanceof Error ? error.message : 'Unexpected server error'
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR',
      message,
    })
  })

  return server
}

export async function startServer({
  host = SERVER_HOST,
  port = SERVER_PORT,
}: ServerOptions = {}): Promise<ReturnType<typeof createServer>> {
  const server = createServer()
  await server.listen({ host, port })
  return server
}
