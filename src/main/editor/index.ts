import { request } from 'node:http'
import { BrowserWindow, WebContentsView } from 'electron'
import { ADE_APP_ROLE, APP_FOCUS_EVENT } from '../../api/server/appFocus'
import { SERVER_ORIGIN } from '../../api/server/config'
import {
  EDITOR_COMMAND_ACK_PATH,
  EDITOR_COMMAND_STREAM_PATH,
  EDITOR_READY_PATH,
  EditorCommandSseEvents,
  type EditorCommand as EditorCommandType,
} from '../../api/server/editor'
import { logger } from '../../server/logger'
import { reportAppFocus } from '../appFocus'
import { connectSseClient } from '../sse'
import { showWindowOnCurrentWorkspace } from '../windowFocus'

const log = logger.child({ process: 'editor' })

let window: BrowserWindow | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let commandStreamReady: Promise<void> | null = null
let activeWorktreeId: string | null = null
let readyPosted = false
const views = new Map<string, WebContentsView>()

export function createWindow(): BrowserWindow {
  window = new BrowserWindow({
    width: 1280,
    height: 900,
    acceptFirstMouse: true,
    show: false,
    title: 'ADE Editor',
    backgroundColor: '#111113',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:ade-editor',
      sandbox: true,
    },
  })

  window.on('closed', () => {
    log.info('editor window closed')
    reportAppFocus(ADE_APP_ROLE.editor, APP_FOCUS_EVENT.closed, log)
    views.clear()
    activeWorktreeId = null
    window = null
  })
  window.on('focus', () => {
    reportAppFocus(ADE_APP_ROLE.editor, APP_FOCUS_EVENT.focused, log)
  })
  window.on('resize', resizeViews)
  window.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<style>
html,body{height:100%;margin:0;background:#111113;color:#edeef0;font:13px system-ui,sans-serif}
body{display:grid;place-items:center}
</style>
<body>Waiting for editor...</body>`),
  )
  window.maximize()

  void connectEditorCommandStream().catch(() => undefined)
  return window
}

function connectEditorCommandStream(): Promise<void> {
  if (commandStreamReady) {
    return commandStreamReady
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const requestUrl = new URL(EDITOR_COMMAND_STREAM_PATH, SERVER_ORIGIN)
  commandStreamReady = new Promise<void>((resolve, reject) => {
    let opened = false
    connectSseClient({
      log,
      onEnd: () => {
        commandStreamReady = null
        if (!opened) {
          reject(new Error('editor command stream ended before opening'))
        }
        scheduleReconnect()
      },
      onError: (error) => {
        commandStreamReady = null
        if (!opened) {
          reject(error)
        }
        log.warn({ err: error }, 'editor command stream failed')
        scheduleReconnect()
      },
      onMessage: (message) => handleEditorCommand(message.data),
      onOpen: (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          const error = new Error('editor command stream rejected')
          commandStreamReady = null
          log.warn(
            { statusCode: response.statusCode },
            'editor command stream rejected',
          )
          reject(error)
          return
        }
        opened = true
        resolve()
        void postReadyIfPossible()
      },
      schemas: EditorCommandSseEvents,
      stream: 'editor-command',
      url: requestUrl,
    })
  })
  return commandStreamReady
}

function handleEditorCommand(command: EditorCommandType): void {
  if (command.type === 'switch') {
    switchWorktree(command)
    return
  }
  if (command.type === 'show') {
    showEditorWindow()
    return
  }
  if (command.type === 'focus') {
    focusEditorWindow()
    return
  }
  if (command.type === 'open-file') {
    // Bring the worktree's editor to the front; the injected ADE helper
    // extension opens the file via its back-channel to the server.
    switchWorktree({
      type: 'switch',
      worktreeId: command.worktreeId,
      url: command.url,
    })
    focusEditorWindow()
    return
  }
  if (command.type === 'close') {
    void closeWorktreeView(command.worktreeId)
      .then(() => postEditorCommandAck(command.commandId))
      .catch((error: unknown) => {
        log.error(
          {
            err: error,
            commandId: command.commandId,
            worktreeId: command.worktreeId,
          },
          'failed to close editor view',
        )
      })
    return
  }
  log.warn({ command }, 'unknown editor command')
}

function switchWorktree(
  command: Extract<EditorCommandType, { type: 'switch' }>,
): void {
  if (!window) {
    window = createWindow()
  }

  const view = getOrCreateWorktreeView(command)
  if (activeWorktreeId === command.worktreeId) {
    view.setVisible(true)
    return
  }

  log.info(
    { worktreeId: command.worktreeId, url: command.url },
    'switching editor',
  )
  const activeView = activeWorktreeId ? views.get(activeWorktreeId) : undefined
  activeView?.setVisible(false)

  resizeView(view)
  window.contentView.addChildView(view)
  view.setVisible(true)
  activeWorktreeId = command.worktreeId
}

function showEditorWindow(): void {
  if (!window) {
    return
  }
  showWindowOnCurrentWorkspace(window, { focus: false })
}

function focusEditorWindow(): void {
  if (!window) {
    return
  }
  showWindowOnCurrentWorkspace(window, { focus: true })
}

async function postReadyIfPossible(): Promise<void> {
  if (readyPosted || !commandStreamReady) {
    return
  }
  const streamReady = commandStreamReady
  try {
    await streamReady
  } catch {
    return
  }
  if (streamReady !== commandStreamReady || readyPosted) {
    return
  }

  const launchId = process.env.ADE_EDITOR_LAUNCH_ID
  if (!launchId) {
    log.warn('editor launch id is missing; readiness not posted')
    return
  }

  readyPosted = true
  const body = JSON.stringify({ launchId })
  const readyRequest = request(
    new URL(EDITOR_READY_PATH, SERVER_ORIGIN),
    {
      headers: {
        'content-length': Buffer.byteLength(body).toString(),
        'content-type': 'application/json',
      },
      method: 'POST',
    },
    (response) => {
      if ((response.statusCode ?? 500) >= 400) {
        log.warn(
          { launchId, statusCode: response.statusCode },
          'editor readiness rejected',
        )
      }
      response.resume()
    },
  )
  readyRequest.on('error', (error) => {
    readyPosted = false
    log.warn({ err: error, launchId }, 'failed to post editor readiness')
  })
  readyRequest.end(body)
}

function getOrCreateWorktreeView(
  command: Extract<EditorCommandType, { type: 'switch' }>,
): WebContentsView {
  const existing = views.get(command.worktreeId)
  if (existing) {
    return existing
  }

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:ade-editor',
      sandbox: true,
    },
  })
  view.setBackgroundColor('#111113')
  view.setVisible(false)
  resizeView(view)
  views.set(command.worktreeId, view)

  view.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription) => {
      log.warn(
        { worktreeId: command.worktreeId, errorCode, errorDescription },
        'editor view failed to load',
      )
    },
  )
  void view.webContents.loadURL(command.url).catch((error: unknown) => {
    log.error(
      { err: error, worktreeId: command.worktreeId, url: command.url },
      'editor view load failed',
    )
  })

  return view
}

async function closeWorktreeView(worktreeId: string): Promise<void> {
  const view = views.get(worktreeId)
  if (!view) {
    return
  }

  views.delete(worktreeId)
  if (activeWorktreeId === worktreeId) {
    activeWorktreeId = null
  }
  try {
    window?.contentView.removeChildView(view)
  } catch (error) {
    log.warn({ err: error, worktreeId }, 'editor view detach failed')
  }
  const destroyed = waitForWebContentsDestroyed(view)
  view.webContents.close()
  await destroyed
  log.info({ worktreeId }, 'editor view closed')
}

function waitForWebContentsDestroyed(view: WebContentsView): Promise<void> {
  if (view.webContents.isDestroyed()) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    view.webContents.once('destroyed', () => resolve())
  })
}

function postEditorCommandAck(commandId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(EDITOR_COMMAND_ACK_PATH, SERVER_ORIGIN)
    const body = JSON.stringify({ commandId })
    const ackRequest = request(
      requestUrl,
      {
        method: 'POST',
        headers: {
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json',
        },
      },
      (response) => {
        response.resume()
        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 400) {
            reject(
              new Error(`Editor command ack failed: ${response.statusCode}`),
            )
            return
          }
          resolve()
        })
      },
    )
    ackRequest.on('error', reject)
    ackRequest.end(body)
  })
}

function resizeViews(): void {
  for (const view of views.values()) {
    resizeView(view)
  }
}

function resizeView(view: WebContentsView): void {
  if (!window) {
    return
  }
  const [width, height] = window.getContentSize()
  view.setBounds({ x: 0, y: 0, width, height })
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectEditorCommandStream().catch(() => undefined)
  }, 1000)
}
