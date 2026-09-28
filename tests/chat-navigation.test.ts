import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { on, once } from 'node:events'
import { test, type TestContext } from 'node:test'
import { WebSocket } from 'ws'
import { ChatService } from '../src/server/chat-service.ts'
import { startCompanionServer } from '../src/server/server.ts'

async function peer(t: TestContext, url: string | URL, token?: string) {
  const socket = new WebSocket(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  const messages = on(socket, 'message')
  t.after(() => {
    void messages.return?.()
    socket.terminate()
  })
  await once(socket, 'open')
  return {
    socket,
    send: (message: object) => socket.send(JSON.stringify(message)),
    take: async (type: string) => {
      for (;;) {
        const { value } = await messages.next()
        const message = JSON.parse(value![0].toString())
        if (message.type === type) return message
      }
    },
  }
}

test(
  'navigation completion reaches its desktop before and after view readiness',
  { timeout: 10_000 },
  async (t) => {
    const services: ChatService[] = []
    const listen = ChatService.prototype.listen
    t.mock.method(
      ChatService.prototype,
      'listen',
      function (this: ChatService) {
        services.push(this)
        return listen.call(this)
      },
    )
    const server = await startCompanionServer({
      config: { projects: [] },
      port: 0,
    })
    t.after(() => server.close())
    const [chats] = services
    const worktree = { project: '/project', path: '/project/branch' }
    t.mock.method(chats.store, 'get', () => ({
      editorId: 'target',
      chat: {
        ...worktree,
        id: 'chat',
        terminalId: 'terminal',
        provider: 'codex',
        sessionId: 'session',
        activity: 'idle' as const,
      },
    }))
    const extension = async (id: string) => {
      const env = chats.environment(id, worktree)
      const url = new URL('/extension', env.ADE_CHAT_ENDPOINT)
      url.protocol = 'ws:'
      url.searchParams.set('activation', randomUUID())
      url.searchParams.set('startedAt', String(Date.now()))
      return peer(t, url, chats.extensionToken(id))
    }
    const desktop = await peer(t, server.url)
    const source = await extension('source')
    const target = await extension('target')
    const activate = async (id: string) => {
      source.send({ type: 'activate', id, chatId: 'chat' })
      return (await desktop.take('chat:activate')).id as string
    }
    const ready = async (id: string) => {
      desktop.send({ type: 'chat:view-ready', id, activationAfter: null })
      desktop.send({ type: 'ping', id: 'barrier' })
      await desktop.take('pong')
    }
    t.mock.timers.enable({ apis: ['setTimeout'] })
    for (const pageReady of [false, true]) {
      const request = `timeout-${pageReady}`
      const id = await activate(request)
      if (pageReady) {
        await ready(id)
        assert.equal((await target.take('focus')).id, id)
      }
      t.mock.timers.tick(30_000)
      assert.equal((await desktop.take('chat:finished')).id, id)
      const result = await source.take('result')
      assert.equal(result.id, request)
      assert.match(result.error, /did not become ready/)
      if (pageReady) assert.equal((await target.take('cancel-focus')).id, id)
    }
    t.mock.timers.reset()

    const first = await activate('first')
    source.send({ type: 'activate', id: 'second', chatId: 'chat' })
    assert.equal((await desktop.take('chat:finished')).id, first)
    const second = (await desktop.take('chat:activate')).id
    assert.match((await source.take('result')).error, /Superseded/)
    await ready(second)
    const focus = await target.take('focus')
    assert.equal(focus.id, second)
    target.send({ type: 'focused', id: second })
    assert.equal((await desktop.take('chat:finished')).id, second)
    assert.equal((await source.take('result')).error, undefined)

    const disconnected = await activate('disconnect')
    await ready(disconnected)
    const sourceClosed = once(source.socket, 'close')
    source.socket.close()
    await sourceClosed
    assert.equal((await desktop.take('chat:finished')).id, disconnected)
    assert.equal((await target.take('cancel-focus')).id, disconnected)

    const replacement = await extension('replacement')
    replacement.send({
      type: 'activate',
      id: 'desktop-disconnect',
      chatId: 'chat',
    })
    const pending = (await desktop.take('chat:activate')).id
    await ready(pending)
    desktop.socket.close()
    assert.match(
      (await replacement.take('result')).error,
      /Desktop disconnected/,
    )
    assert.equal((await target.take('cancel-focus')).id, pending)
  },
)
