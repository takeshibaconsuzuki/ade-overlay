import type { NotificationConstructorOptions } from 'electron'
import type { Chat } from '../shared/chats.ts'

interface ChatNotification {
  on(event: 'click', listener: () => void): unknown
  on(event: 'failed', listener: (event: unknown, error: string) => void): unknown
  removeAllListeners(): unknown
  show(): void
  close(): void
}

export class ChatNotifications {
  private readonly notifications = new Map<string, ChatNotification>()
  private readonly create: (
    options: NotificationConstructorOptions,
  ) => ChatNotification | undefined
  private readonly activate: (id: string) => Promise<unknown>
  private readonly onError: (error: unknown) => void

  constructor(
    create: ChatNotifications['create'],
    activate: ChatNotifications['activate'],
    onError: ChatNotifications['onError'],
  ) {
    this.create = create
    this.activate = activate
    this.onError = onError
  }

  show(chat: Chat): void {
    this.dismiss(chat.id)
    const notification = this.create({
      title: chat.title ? `${chat.title} — Idle` : 'Chat is idle',
      body: chat.message || chat.path,
    })
    if (!notification) return
    this.notifications.set(chat.id, notification)
    notification.on('click', () => {
      this.dismiss(chat.id)
      void this.activate(chat.id).catch(this.onError)
    })
    notification.on('failed', (_event, error) => {
      this.dismiss(chat.id)
      console.warn('[ADE] Could not show chat notification:', error)
    })
    // Windows can emit close when the toast moves to Action Center. Retain the
    // click handler until replacement or disconnection so it still opens chat.
    notification.show()
  }

  clear(): void {
    for (const id of this.notifications.keys()) this.dismiss(id)
  }

  private dismiss(id: string): void {
    const notification = this.notifications.get(id)
    if (!notification) return
    this.notifications.delete(id)
    notification.removeAllListeners()
    notification.close()
  }
}
