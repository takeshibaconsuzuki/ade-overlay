import { request, type ClientRequest } from 'node:http'
import { basename } from 'node:path'
import {
  BrowserWindow,
  dialog,
  Notification,
  type MessageBoxOptions,
  type NotificationConstructorOptions,
} from 'electron'
import { SERVER_ORIGIN } from '../../api/server/config'
import { WORKTREE_EVENT_TYPE } from '../../api/server/events'
import { type Logger } from '../../api/server/logger'
import {
  worktreeCreationLogsOpenPath,
  WorktreeEvent,
  worktreeOpenPath,
  WORKTREES_PATH,
  type Worktree,
  type WorktreeEvent as WorktreeEventType,
} from '../../api/server/worktrees'

const NOTIFICATION_GROUP_ID = 'worktree-creation'
const RECONNECT_DELAY_MS = 1000

type WorktreeNotificationEvent = Extract<
  WorktreeEventType,
  {
    type:
      | typeof WORKTREE_EVENT_TYPE.worktreeCreated
      | typeof WORKTREE_EVENT_TYPE.worktreeCreationUpdated
      | typeof WORKTREE_EVENT_TYPE.worktreeDeleted
  }
>

export function registerWorktreeCreationNotifications(log: Logger): () => void {
  const notifiedWorktreeIds = new Set<string>()
  const activeNotifications = new Set<Notification>()
  let streamRequest: ClientRequest | null = null
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

    const requestUrl = new URL(WORKTREES_PATH, SERVER_ORIGIN)
    streamRequest = request(requestUrl, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        log.warn(
          { statusCode: response.statusCode },
          'worktree notification stream rejected',
        )
        response.resume()
        response.on('end', scheduleReconnect)
        return
      }

      response.setEncoding('utf8')
      let buffer = ''
      response.on('data', (chunk: string) => {
        buffer += chunk
        let delimiterIndex = buffer.indexOf('\n\n')
        while (delimiterIndex >= 0) {
          const rawEvent = buffer.slice(0, delimiterIndex)
          buffer = buffer.slice(delimiterIndex + 2)
          handleStreamEvent(
            rawEvent,
            notifiedWorktreeIds,
            activeNotifications,
            log,
          )
          delimiterIndex = buffer.indexOf('\n\n')
        }
      })
      response.on('end', scheduleReconnect)
    })

    streamRequest.on('error', (error) => {
      if (!stopped) {
        log.warn({ err: error }, 'worktree notification stream failed')
      }
      scheduleReconnect()
    })
    streamRequest.end()
  }

  const scheduleReconnect = (): void => {
    streamRequest = null
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
    streamRequest?.destroy()
    streamRequest = null
    for (const notification of activeNotifications) {
      notification.close()
    }
    activeNotifications.clear()
  }
}

function handleStreamEvent(
  rawEvent: string,
  notifiedWorktreeIds: Set<string>,
  activeNotifications: Set<Notification>,
  log: Logger,
): void {
  const { event, data } = parseSseEvent(rawEvent)
  if (
    !data ||
    (event !== WORKTREE_EVENT_TYPE.worktreeCreated &&
      event !== WORKTREE_EVENT_TYPE.worktreeCreationUpdated &&
      event !== WORKTREE_EVENT_TYPE.worktreeDeleted)
  ) {
    return
  }

  try {
    const result = WorktreeEvent.safeParse(JSON.parse(data))
    if (!result.success) {
      log.error({ err: result.error, data }, 'invalid worktree notification')
      return
    }
    const streamEvent = result.data
    if (event !== streamEvent.type) {
      log.warn({ event, streamEvent }, 'worktree notification event mismatch')
      return
    }
    if (!isWorktreeNotificationEvent(streamEvent)) {
      return
    }
    handleWorktreeEvent(
      streamEvent,
      notifiedWorktreeIds,
      activeNotifications,
      log,
    )
  } catch (error) {
    log.error({ err: error, data }, 'failed to parse worktree notification')
  }
}

function isWorktreeNotificationEvent(
  event: WorktreeEventType,
): event is WorktreeNotificationEvent {
  return (
    event.type === WORKTREE_EVENT_TYPE.worktreeCreated ||
    event.type === WORKTREE_EVENT_TYPE.worktreeCreationUpdated ||
    event.type === WORKTREE_EVENT_TYPE.worktreeDeleted
  )
}

function parseSseEvent(rawEvent: string): {
  event: string | null
  data: string
} {
  const lines = rawEvent.split('\n')
  const event =
    lines
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim() ?? null
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n')
  return { event, data }
}

function handleWorktreeEvent(
  event: WorktreeNotificationEvent,
  notifiedWorktreeIds: Set<string>,
  activeNotifications: Set<Notification>,
  log: Logger,
): void {
  if (event.type === WORKTREE_EVENT_TYPE.worktreeCreated) {
    if (notifiedWorktreeIds.has(event.worktree.worktreeId)) {
      return
    }
    notifiedWorktreeIds.add(event.worktree.worktreeId)
    showWorktreeNotification({
      action: () => openWorktree(event.worktree.worktreeId, log),
      actionText: 'Open',
      activeNotifications,
      body: event.worktree.path,
      dialogType: 'info',
      log,
      notificationAction: false,
      title: `Worktree created: ${worktreeName(event.worktree)}`,
      worktreeId: event.worktree.worktreeId,
    })
    return
  }

  if (event.type === WORKTREE_EVENT_TYPE.worktreeDeleted) {
    notifiedWorktreeIds.delete(event.worktreeId)
    return
  }

  const worktree = event.snapshot.worktrees.find(
    (candidate) => candidate.worktreeId === event.worktreeId,
  )
  if (!worktree) {
    notifiedWorktreeIds.delete(event.worktreeId)
    return
  }
  if (
    worktree.creationState === 'creating' ||
    worktree.creationState === 'bootstrapping'
  ) {
    notifiedWorktreeIds.delete(worktree.worktreeId)
    return
  }
  if (
    worktree.creationState !== 'failed' ||
    notifiedWorktreeIds.has(worktree.worktreeId)
  ) {
    return
  }

  notifiedWorktreeIds.add(worktree.worktreeId)
  showWorktreeNotification({
    action: () => openCreationLogs(worktree.worktreeId, log),
    actionText: 'Open creation logs',
    activeNotifications,
    body: worktree.creationError ?? worktree.path,
    dialogType: 'error',
    log,
    notificationAction: false,
    title: `Worktree creation failed: ${worktreeName(worktree)}`,
    worktreeId: worktree.worktreeId,
  })
}

function showWorktreeNotification({
  action,
  actionText,
  activeNotifications,
  body,
  dialogType,
  log,
  notificationAction = true,
  title,
  worktreeId,
}: {
  action: () => Promise<void>
  actionText: string
  activeNotifications: Set<Notification>
  body: string
  dialogType: MessageBoxOptions['type']
  log: Logger
  notificationAction?: boolean
  title: string
  worktreeId: string
}): void {
  if (!Notification.isSupported()) {
    log.warn({ worktreeId }, 'native notifications are not supported')
    showFallbackDialog({
      action,
      actionText,
      body,
      dialogType,
      log,
      title,
      worktreeId,
    })
    return
  }

  showNotification(
    {
      title,
      body,
      groupId: NOTIFICATION_GROUP_ID,
      actions: notificationAction
        ? [{ type: 'button', text: actionText }]
        : undefined,
    },
    action,
    activeNotifications,
    log,
    worktreeId,
    { actionText, body, dialogType, title },
  )
}

function showNotification(
  options: NotificationConstructorOptions,
  action: () => Promise<void>,
  activeNotifications: Set<Notification>,
  log: Logger,
  worktreeId: string,
  fallback: {
    actionText: string
    body: string
    dialogType: MessageBoxOptions['type']
    title: string
  },
): void {
  const notification = new Notification(options)

  let actionStarted = false
  const runAction = (): void => {
    if (actionStarted) {
      return
    }
    actionStarted = true
    notification.close()
    void action().catch((error: unknown) => {
      log.warn({ err: error, worktreeId }, 'notification action failed')
    })
  }

  notification.on('click', runAction)
  notification.on('action', runAction)
  notification.on('failed', (_event, error) => {
    log.warn({ error, worktreeId }, 'worktree notification failed')
    activeNotifications.delete(notification)
    showFallbackDialog({
      action,
      actionText: fallback.actionText,
      body: fallback.body,
      dialogType: fallback.dialogType,
      log,
      title: fallback.title,
      worktreeId,
    })
  })
  notification.on('close', () => {
    activeNotifications.delete(notification)
  })

  activeNotifications.add(notification)
  notification.show()
}

function showFallbackDialog({
  action,
  actionText,
  body,
  dialogType,
  log,
  title,
  worktreeId,
}: {
  action: () => Promise<void>
  actionText: string
  body: string
  dialogType: MessageBoxOptions['type']
  log: Logger
  title: string
  worktreeId: string
}): void {
  const options: MessageBoxOptions = {
    type: dialogType,
    title,
    message: title,
    detail: body,
    buttons: [actionText, 'Dismiss'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const parent = BrowserWindow.getFocusedWindow()
  const messageBox = parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options)

  log.info(
    { worktreeId, parentWindow: Boolean(parent) },
    'showing fallback dialog',
  )
  void messageBox
    .then(({ response }) => {
      if (response !== 0) {
        return
      }
      return action()
    })
    .catch((error: unknown) => {
      log.warn(
        { err: error, worktreeId },
        'notification fallback dialog failed',
      )
    })
}

async function openWorktree(worktreeId: string, log: Logger): Promise<void> {
  await post(worktreeOpenPath(worktreeId))
  log.info({ worktreeId }, 'opened worktree from notification')
}

async function openCreationLogs(
  worktreeId: string,
  log: Logger,
): Promise<void> {
  await post(worktreeCreationLogsOpenPath(worktreeId))
  log.info({ worktreeId }, 'opened creation logs from notification')
}

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(new URL(path, SERVER_ORIGIN), {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    throw new Error(
      `POST ${path} failed with ${response.status}: ${await response.text()}`,
    )
  }
}

function worktreeName(worktree: Worktree): string {
  return basename(worktree.path) || worktree.branchName || worktree.worktreeId
}
