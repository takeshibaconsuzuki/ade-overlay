import Fastify, { type FastifyInstance } from 'fastify'
import fastifySwagger from '@fastify/swagger'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { OPENAPI_PATH, SERVER_HOST, SERVER_PORT } from './config'
import { HttpError, getStatusCode } from './errors'
import { registerWorktreeRoutes } from './worktrees/routes'

export type ServerOptions = {
  host?: string
  port?: number
}

export function createServer(): FastifyInstance {
  const server = Fastify({ logger: true })

  server.setValidatorCompiler(validatorCompiler)
  server.setSerializerCompiler(serializerCompiler)
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

  registerWorktreeRoutes(server)

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
}: ServerOptions = {}): Promise<FastifyInstance> {
  const server = createServer()
  await server.listen({ host, port })
  return server
}
