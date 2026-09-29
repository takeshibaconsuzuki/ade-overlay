import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { NotificationConstructorOptions } from 'electron'
import { WorktreeNotifications } from '../../src/main/worktree-notifications.ts'
import type { OpenEditorInput, Worktree } from '../../src/shared/companion.ts'

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

const row = (overrides: Partial<Worktree> = {}): Worktree => ({
  project: '/project',
  path: '/project/new',
  branch: 'new',
  main: false,
  locked: false,
  prunable: false,
  editor: 'stopped',
  ...overrides,
})

function fixture(open?: (input: OpenEditorInput) => Promise<void>) {
  const created: {
    notification: FakeNotification
    options: NotificationConstructorOptions
  }[] = []
  const opened: OpenEditorInput[] = []
  const errors: unknown[] = []
  const notifications = new WorktreeNotifications(
    (options) => {
      const notification = new FakeNotification()
      created.push({ notification, options })
      return notification
    },
    async (input) => {
      opened.push(input)
      await open?.(input)
    },
    (error) => errors.push(error),
  )
  let revision = 0
  const update = (...worktrees: Worktree[]) =>
    notifications.update({ revision: ++revision, projects: [], worktrees })
  return { notifications, created, opened, errors, update }
}

test('creation notifies once after all creating snapshots, including bootstrap, finish', () => {
  const { update, created, opened } = fixture()
  update(row()) // Existing worktrees do not notify on connection.
  update(row({ missing: true, operation: 'creating' }))
  update(row({ operation: 'creating' })) // Git checkout exists, bootstrap pending.
  update(row({ operation: 'creating', editor: 'starting' }))
  assert.equal(created.length, 0)
  update(row())
  update(row({ editor: 'running' }))
  assert.equal(created.length, 1)
  assert.equal(created[0].notification.shown, true)
  assert.equal(created[0].options.title, 'Worktree creation completed')
  assert.equal(created[0].options.body, '/project/new')
  assert.deepEqual(opened, [])
  created[0].notification.emit('close') // Windows Action Center retains clicks.
  created[0].notification.emit('click')
  created[0].notification.emit('click')
  assert.deepEqual(opened, [{ project: '/project', path: '/project/new' }])
})

test('bootstrap failure opens the retained worktree; Git failure without one does nothing', () => {
  for (const missing of [false, true]) {
    const { update, created, opened } = fixture()
    update(row({ operation: 'creating', missing: true }))
    update(row({ missing, error: 'Creation failed' }))
    assert.equal(created.length, 1)
    assert.equal(created[0].options.title, 'Worktree creation failed')
    assert.match(created[0].options.body!, /Creation failed/)
    created[0].notification.emit('click')
    assert.equal(opened.length, missing ? 0 : 1)
  }
})

test('clicks check current membership and availability, including cleared synthetic rows', () => {
  for (const current of [
    [],
    [row({ missing: true })],
    [row({ prunable: true })],
    [row({ operation: 'deleting' })],
    [row({ operation: 'creating' })],
  ]) {
    const { update, created, opened } = fixture()
    update(row({ operation: 'creating' }))
    update(row())
    update(...current)
    created[0].notification.emit('click')
    assert.deepEqual(opened, [])
  }
})

test('deletion, initial failures, and error clearing do not notify', () => {
  const { update, created } = fixture()
  update(row({ missing: true, error: 'An earlier failure' }))
  update()
  update(row({ operation: 'deleting' }))
  update(row({ error: 'Deletion failed' }))
  update(row())
  update(row({ operation: 'deleting' }))
  update()
  assert.equal(created.length, 0)
})

test('notifications retain distinct project identities, replace retries, and clear on disconnect', () => {
  const { notifications, update, created, opened } = fixture()
  const other = row({ project: '/other-project' })
  update(row({ operation: 'creating' }), { ...other, operation: 'creating' })
  update(row({ error: 'Failed' }), other)
  assert.equal(created.length, 2)
  update(row({ operation: 'creating' }), other)
  update(row(), other)
  assert.equal(created.length, 3)
  assert.equal(created[0].notification.closed, true)
  created[0].notification.emit('click')
  assert.deepEqual(opened, [])
  created[1].notification.emit('click')
  assert.deepEqual(opened, [{ project: other.project, path: other.path }])
  update(row({ operation: 'creating' }))
  notifications.clear()
  update(row()) // Reconnection must not infer an old operation's outcome.
  assert.equal(created.length, 3)
  for (const { notification } of created) {
    assert.equal(notification.closed, true)
    notification.emit('click')
  }
  assert.equal(opened.length, 1)
})

test('failed notifications are dismissed and navigation failures are handled', async (t) => {
  const { update, created, errors } = fixture(async () => {
    throw new Error('Disconnected')
  })
  update(row({ operation: 'creating' }))
  update(row())
  created[0].notification.emit('click')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(String(errors[0]), /Disconnected/)
  update(row({ operation: 'creating' }))
  update(row())
  const warning = t.mock.method(console, 'warn', () => {})
  created[1].notification.emit('failed', {}, 'Notifications disabled')
  assert.equal(warning.mock.callCount(), 1)
  assert.equal(created[1].notification.closed, true)
  assert.equal(created[1].notification.listenerCount('click'), 0)
})

test('unsupported notifications do not affect worktree completion', () => {
  const notifications = new WorktreeNotifications(
    () => undefined,
    async () => assert.fail('No notification to click'),
    () => assert.fail('No navigation error'),
  )
  notifications.update({
    revision: 1,
    projects: [],
    worktrees: [row({ operation: 'creating' })],
  })
  notifications.update({ revision: 2, projects: [], worktrees: [row()] })
  notifications.clear()
})
