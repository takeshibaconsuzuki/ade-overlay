import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { NotificationConstructorOptions } from 'electron'
import { ChatNotifications } from '../../src/main/chat-notifications.ts'

class FakeNotification extends EventEmitter {
  shown = false
  closed = false
  show(): void {
    this.shown = true
  }
  close(): void {
    this.closed = true
  }
}

test('notification clicks preserve chat identity, survive toast dismissal, and handle failures', async () => {
  const created: {
    notification: FakeNotification
    options: NotificationConstructorOptions
  }[] = []
  const opened: string[] = []
  const errors: unknown[] = []
  const notifications = new ChatNotifications(
    (options) => {
      const notification = new FakeNotification()
      created.push({ notification, options })
      return notification
    },
    async (id) => {
      opened.push(id)
      throw new Error('This chat is no longer available.')
    },
    (error) => errors.push(error),
  )
  const chat = {
    id: 'first',
    terminalId: 'terminal',
    path: '/project/branch',
    activity: 'idle' as const,
  }
  notifications.show(chat)
  assert.equal(created[0].notification.shown, true)
  assert.equal(created[0].options.body, chat.path)
  notifications.show({ ...chat, title: 'Fix tests', message: 'Tests passed' })
  assert.equal(created[0].notification.closed, true)
  created[0].notification.emit('click')
  assert.deepEqual(opened, [])
  assert.match(created[1].options.title!, /Fix tests/)
  assert.equal(created[1].options.body, 'Tests passed')
  created[1].notification.emit('close')
  created[1].notification.emit('click')
  await Promise.resolve()
  assert.deepEqual(opened, ['first'])
  assert.match(String(errors[0]), /no longer available/)
  created[1].notification.emit('click')
  assert.deepEqual(opened, ['first'])
  notifications.show(chat)
  notifications.show({ ...chat, id: 'second' })
  notifications.clear()
  for (const { notification } of created) {
    assert.equal(notification.closed, true)
    notification.emit('click')
  }
  assert.deepEqual(opened, ['first'])
})

test('unsupported notifications do not affect chat navigation', () => {
  const notifications = new ChatNotifications(
    () => undefined,
    async () => assert.fail('No notification to click'),
    () => assert.fail('No navigation error'),
  )
  notifications.show({
    id: 'chat',
    terminalId: 'terminal',
    path: '/project',
    activity: 'idle',
  })
  notifications.clear()
})
