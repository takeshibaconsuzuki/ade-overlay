import { Notification } from 'electron'
import {
  CHAT_EVENT_TYPE,
  CHAT_SHOW_PATH,
  CHAT_STATUS,
  CHAT_STREAM_PATH,
  ChatSseEvents,
  chatProviderLabel,
  parseChatProviderId,
  type Chat,
  type ChatStatus,
} from '../../api/server/chats'
import { SERVER_ORIGIN } from '../../api/server/config'
import { type Logger } from '../../api/server/logger'
import { SSE_SNAPSHOT_EVENT } from '../../api/server/sse'
import { connectSseClient } from '../sse'

const NOTIFICATION_GROUP_ID = 'chat-idle'
const RECONNECT_DELAY_MS = 1000

export function registerChatIdleNotifications(log: Logger): () => void {
  const statuses = new Map<string, ChatStatus>()
  const activeNotifications = new Map<string, Notification>()
  let streamClient: { close: () => void } | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let stopped = false

  const connect = (): void => {
    if (stopped) {
      return
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    streamClient = connectSseClient({
      log,
      onEnd: () => {
        streamClient = null
        scheduleReconnect()
      },
      onError: (error) => {
        streamClient = null
        if (!stopped) {
          log.warn({ err: error }, 'chat notification stream failed')
        }
        scheduleReconnect()
      },
      onMessage: (message) => {
        if (message.type === SSE_SNAPSHOT_EVENT) {
          updateStatuses(message.data.chats, statuses)
          return
        }

        if (message.type !== CHAT_EVENT_TYPE.chatUpdated) {
          return
        }

        const chat = message.data.chat
        const key = chatKey(chat)
        const previousStatus = statuses.get(key)
        updateStatuses(message.data.snapshot.chats, statuses)

        if (chat.status !== CHAT_STATUS.idle) {
          closeActiveNotification(key, activeNotifications)
          return
        }
        if (
          previousStatus &&
          previousStatus !== CHAT_STATUS.idle &&
          isOpenableLiveChat(chat)
        ) {
          showIdleChatNotification(chat, activeNotifications, log)
        }
      },
      onOpen: (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          log.warn(
            { statusCode: response.statusCode },
            'chat notification stream rejected',
          )
          response.resume()
        }
      },
      schemas: ChatSseEvents,
      stream: 'chat-notification',
      url: new URL(CHAT_STREAM_PATH, SERVER_ORIGIN),
    })
  }

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) {
      return
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, RECONNECT_DELAY_MS)
  }

  connect()

  return () => {
    stopped = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    streamClient?.close()
    streamClient = null
    for (const notification of activeNotifications.values()) {
      notification.close()
    }
    activeNotifications.clear()
  }
}

function updateStatuses(
  chats: Chat[],
  statuses: Map<string, ChatStatus>,
): void {
  statuses.clear()
  for (const chat of chats) {
    statuses.set(chatKey(chat), chat.status)
  }
}

function showIdleChatNotification(
  chat: OpenableLiveChat,
  activeNotifications: Map<string, Notification>,
  log: Logger,
): void {
  const key = chatKey(chat)
  if (activeNotifications.has(key)) {
    return
  }

  if (!Notification.isSupported()) {
    log.warn(
      { chatId: chat.chatId, providerId: chat.providerId },
      'native notifications are not supported',
    )
    return
  }

  const notification = new Notification({
    title: `${chatProviderLabel(parseChatProviderId(chat.providerId))} chat is waiting`,
    body: notificationBody(chat),
    groupId: NOTIFICATION_GROUP_ID,
  })

  let actionStarted = false
  const runAction = (): void => {
    if (actionStarted) {
      return
    }
    actionStarted = true
    notification.close()
    void openLiveChat(chat, log).catch((error: unknown) => {
      log.warn(
        { err: error, chatId: chat.chatId, providerId: chat.providerId },
        'chat idle notification action failed',
      )
    })
  }

  notification.on('click', runAction)
  notification.on('failed', (_event, error) => {
    log.warn(
      { error, chatId: chat.chatId, providerId: chat.providerId },
      'chat idle notification failed',
    )
    activeNotifications.delete(key)
  })
  notification.on('close', () => {
    activeNotifications.delete(key)
  })

  activeNotifications.set(key, notification)
  notification.show()
}

function closeActiveNotification(
  key: string,
  activeNotifications: Map<string, Notification>,
): void {
  const notification = activeNotifications.get(key)
  if (!notification) {
    return
  }
  notification.close()
  activeNotifications.delete(key)
}

function notificationBody(chat: Chat): string {
  const lines = [chat.title, chat.description]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
  return lines.join('\n') || 'Click to open the live chat.'
}

type OpenableLiveChat = Chat & {
  terminalId: string
  worktreeId: string
}

function isOpenableLiveChat(chat: Chat): chat is OpenableLiveChat {
  return Boolean(chat.terminalId && chat.worktreeId)
}

async function openLiveChat(chat: OpenableLiveChat, log: Logger): Promise<void> {
  await post(CHAT_SHOW_PATH, {
    worktreeId: chat.worktreeId,
    providerId: chat.providerId,
    chatId: chat.chatId,
  })
  log.info(
    {
      chatId: chat.chatId,
      providerId: chat.providerId,
      terminalId: chat.terminalId,
      worktreeId: chat.worktreeId,
    },
    'opened live chat from notification',
  )
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(new URL(path, SERVER_ORIGIN), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(
      `POST ${path} failed with ${response.status}: ${await response.text()}`,
    )
  }
}

function chatKey(chat: Pick<Chat, 'chatId' | 'providerId'>): string {
  return `${chat.providerId}:${chat.chatId}`
}
