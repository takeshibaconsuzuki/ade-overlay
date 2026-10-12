import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { startRpcServer } from '../src/server/server'
import { chatRoutes } from '../src/server/chat-routes'
import { ChatStore } from '../src/server/chat-store'
import { NodeProcessProbe } from '../src/server/process-probe'
import type { Chat } from '../src/shared/api'
import { TestChatProvider } from './fixtures/chat-provider'

test('unrelated HTTP plugins use framework routing, parsing, validation and error handling', async (t) => {
  const server = await startRpcServer(
    {},
    { host: '127.0.0.1', port: 0 },
    undefined,
    undefined,
    async (app) => {
      app.register(async (routes) => {
        routes.post<{ Params: { name: string }; Body: { value: string } }>(
          '/utilities/echo/:name',
          {
            schema: {
              body: {
                type: 'object',
                required: ['value'],
                properties: { value: { type: 'string' } },
              },
            },
          },
          async (request, reply) =>
            reply.code(201).send({
              name: request.params.name,
              value: request.body.value,
            }),
        )
      })
      app.register(async (routes) => {
        routes.get('/health', async () => ({ ready: true }))
        routes.get('/failure', async () => {
          throw new Error('Unexpected failure')
        })
      })
    },
  )
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.port}`
  const echo = await fetch(`${base}/utilities/echo/a%20b?source=test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'hello' }),
  })
  assert.equal(echo.status, 201)
  assert.deepEqual(await echo.json(), { name: 'a b', value: 'hello' })
  const invalid = await fetch(`${base}/utilities/echo/a`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(invalid.status, 400)
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
    ready: true,
  })
  assert.equal((await fetch(`${base}/missing`)).status, 404)
  assert.equal((await fetch(`${base}/failure`)).status, 500)
})

class FailingReportProvider extends TestChatProvider {
  override async readReport(): Promise<Chat> {
    throw new Error('Metadata unavailable')
  }
}

test('chat processing failures remain server errors', async (t) => {
  const chats = new ChatStore(new NodeProcessProbe(), [
    new FailingReportProvider(),
  ])
  t.after(() => chats.close())
  const app = Fastify()
  t.after(() => app.close())
  app.register(chatRoutes, { chats })
  const response = await app.inject({
    method: 'POST',
    url: '/chats/report/test',
    payload: {},
  })
  assert.equal(response.statusCode, 500)
})
