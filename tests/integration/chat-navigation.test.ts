import assert from 'node:assert/strict'
import { once } from 'node:events'
import { CompanionClient } from '../../src/main/companion-client.ts'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { ChatService } from '../../src/server/chats/chat-service.ts'
import { startCompanionServer } from '../../src/server/server.ts'
import { socketPeer } from '../helpers/socket.ts'
import {
  companionRequests,
  companionEvents,
} from '../../src/shared/companion.ts'
import { chatRequests, chatEvents } from '../../src/shared/chats.ts'
import { callRpc, sendEvent } from '../../src/shared/rpc.ts'

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
      worktree,
      chat: {
        id: 'chat',
        terminalId: 'terminal',
        path: worktree.path,
        activity: 'idle' as const,
      },
    }))
    const extension = async (id: string) => {
      const { activityEnvironment: env, controlToken } = chats.registerEditor(
        id,
        worktree,
      )
      const url = new URL('/extension', env.ADE_CHAT_ENDPOINT)
      url.searchParams.set('activation', randomUUID())
      url.searchParams.set('startedAt', String(Date.now()))
      return socketPeer(t, url, controlToken)
    }
    const desktop = await socketPeer(t, server.url)
    const source = await extension('source')
    const target = await extension('target')
    const activate = async (peer = source) => {
      const result = callRpc(
        peer.socket,
        peer === desktop
          ? companionRequests.activateChat
          : chatRequests.activate,
        'chat',
      ).catch((error: Error) => error)
      return {
        id: (await desktop.take(companionEvents.activateChat)).id,
        result,
      }
    }
    const ready = async (id: string) => {
      sendEvent(desktop.socket, companionEvents.viewReady, {
        id,
        activationAfter: null,
      })
      await callRpc(desktop.socket, companionRequests.list, null)
    }
    t.mock.timers.enable({ apis: ['setTimeout'] })
    for (const pageReady of [false, true]) {
      const { id, result } = await activate()
      if (pageReady) {
        await ready(id)
        assert.equal((await target.take(chatEvents.focus)).id, id)
      }
      t.mock.timers.tick(30_000)
      assert.equal(await desktop.take(companionEvents.finishChat), id)
      assert.match(String(await result), /did not become ready/)
      if (pageReady) assert.equal(await target.take(chatEvents.cancelFocus), id)
    }
    t.mock.timers.reset()

    const first = await activate()
    const second = await activate()
    assert.equal(await desktop.take(companionEvents.finishChat), first.id)
    assert.match(String(await first.result), /Superseded/)
    await ready(first.id)
    sendEvent(desktop.socket, companionEvents.viewReady, {
      id: first.id,
      error: 'Stale failure',
      activationAfter: null,
    })
    const other = await socketPeer(t, server.url)
    sendEvent(other.socket, companionEvents.viewReady, {
      id: second.id,
      error: 'Wrong desktop',
      activationAfter: null,
    })
    await callRpc(other.socket, companionRequests.list, null)
    other.socket.disconnect()
    await ready(second.id)
    assert.equal((await target.take(chatEvents.focus)).id, second.id)
    let completed = false
    void second.result.then(() => {
      completed = true
    })
    sendEvent(source.socket, chatEvents.focused, {
      id: second.id,
      error: 'Wrong extension',
    })
    await delay(20)
    assert.equal(completed, false)
    sendEvent(target.socket, chatEvents.focused, {
      id: first.id,
      error: 'Stale acknowledgement',
    })
    sendEvent(target.socket, chatEvents.focused, { id: second.id })
    assert.equal(await desktop.take(companionEvents.finishChat), second.id)
    assert.equal(await second.result, null)

    // Notification clicks enter the same navigation path without a source extension.
    const notification = await activate(desktop)
    await ready(notification.id)
    assert.equal((await target.take(chatEvents.focus)).terminalId, 'terminal')
    let notificationCompleted = false
    void notification.result.then(() => {
      notificationCompleted = true
    })
    await delay(20)
    assert.equal(notificationCompleted, false)
    sendEvent(target.socket, chatEvents.focused, { id: notification.id })
    assert.equal(
      await desktop.take(companionEvents.finishChat),
      notification.id,
    )
    assert.equal(await notification.result, null)

    const disconnected = await activate()
    await ready(disconnected.id)
    await target.take(chatEvents.focus)
    source.socket.disconnect()
    assert.match(String(await disconnected.result), /Disconnected/)
    assert.equal(
      await desktop.take(companionEvents.finishChat),
      disconnected.id,
    )
    assert.equal(await target.take(chatEvents.cancelFocus), disconnected.id)

    const replacement = await extension('replacement')
    const pending = await activate(replacement)
    await ready(pending.id)
    desktop.socket.disconnect()
    assert.match(String(await pending.result), /Desktop disconnected/)
    assert.equal(await target.take(chatEvents.cancelFocus), pending.id)
  },
)

test(
  'desktop receives live idle events without replay and can request chat activation',
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
    const desktop = new CompanionClient({ url: server.url })
    t.after(() => desktop.stop())
    const idle = {
      id: 'chat',
      terminalId: 'terminal',
      path: '/project',
      activity: 'idle' as const,
    }
    const received: unknown[] = []
    desktop.on('chatIdle', (chat) => received.push(chat))
    const connect = async () => {
      const connected = new Promise<void>((resolve) => {
        const listener = (status: { state: string }) => {
          if (status.state !== 'connected') return
          desktop.off('status', listener)
          resolve()
        }
        desktop.on('status', listener)
      })
      desktop.connect()
      await connected
      await desktop.listWorktrees()
    }
    chats.store.emit('idle', idle)
    await connect()
    assert.deepEqual(received, [])
    const notified = once(desktop, 'chatIdle')
    chats.store.emit('idle', idle)
    assert.deepEqual(await notified, [idle])
    desktop.stop()
    chats.store.emit('idle', idle)
    await connect()
    assert.deepEqual(received, [idle])
    await assert.rejects(desktop.activateChat('gone'), /no longer available/)
    const activate = t.mock.method(chats, 'activate', async (id: string) => {
      assert.equal(id, idle.id)
      return null
    })
    assert.equal(await desktop.activateChat(idle.id), null)
    assert.equal(activate.mock.callCount(), 1)
    desktop.stop()
    await server.close()
    assert.equal(chats.store.listenerCount('idle'), 0)
  },
)
