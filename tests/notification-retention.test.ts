import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NotificationRetention,
  type RetainedNotification,
} from '../src/desktop/notification-retention'

class Notification implements RetainedNotification {
  closed = false

  constructor(private readonly onClose: () => void = () => {}) {}

  close(): void {
    assert.equal(this.closed, false, 'Notifications must only be evicted once')
    this.closed = true
    this.onClose()
  }
}

test('ignored notifications remain bounded and overflow closes the oldest native entries', () => {
  const retention = new NotificationRetention(100)
  const notifications = Array.from({ length: 1_000 }, () => new Notification())
  for (const notification of notifications) {
    retention.add(notification)
    assert.ok(retention.size <= 100)
  }
  assert.equal(retention.size, 100)
  assert.ok(notifications.slice(0, 900).every((entry) => entry.closed))
  assert.ok(notifications.slice(900).every((entry) => !entry.closed))
})

test('click and dismissal cleanup free capacity without evicting remaining notifications', () => {
  const retention = new NotificationRetention(2)
  const clicked = new Notification()
  const dismissed = new Notification()
  const remaining = new Notification()
  const replacement = new Notification()
  retention.add(clicked)
  retention.add(dismissed)
  retention.delete(clicked)
  retention.delete(dismissed)
  retention.add(remaining)
  retention.add(replacement)
  assert.equal(retention.size, 2)
  assert.equal(remaining.closed, false)
  assert.equal(replacement.closed, false)
})

test('eviction tolerates synchronous close cleanup and preserves insertion order', () => {
  const retention = new NotificationRetention(2)
  const oldest = new Notification(() => retention.delete(oldest))
  const next = new Notification(() => retention.delete(next))
  const newest = new Notification()
  retention.add(oldest)
  retention.add(next)
  retention.add(oldest)
  assert.equal(oldest.closed, false)
  retention.add(newest)
  assert.equal(retention.size, 2)
  assert.equal(oldest.closed, true)
  assert.equal(next.closed, false)
  assert.equal(newest.closed, false)
})
