export interface RetainedNotification {
  close(): void
}

// Keep click handlers alive, closing the oldest native entry before releasing it on overflow.
export class NotificationRetention {
  private readonly notifications = new Set<RetainedNotification>()

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('Notification retention limit must be a positive integer')
  }

  get size(): number {
    return this.notifications.size
  }

  add(notification: RetainedNotification): void {
    if (this.notifications.has(notification)) return
    if (this.notifications.size === this.limit) {
      const oldest = this.notifications.values().next().value!
      oldest.close()
      this.notifications.delete(oldest)
    }
    this.notifications.add(notification)
  }

  delete(notification: RetainedNotification): void {
    this.notifications.delete(notification)
  }
}
