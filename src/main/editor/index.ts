import { BrowserWindow, WebContentsView } from 'electron'
import { request } from 'node:http'
import {
  EDITOR_COMMAND_ACK_PATH,
  type EditorCommand,
} from '../../api/server/editor'
import { SERVER_ORIGIN } from '../../api/server/config'
import { logger } from '../../server/logger'

const log = logger.child({ process: 'editor' })

let window: BrowserWindow | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let activeWorktreeId: string | null = null
const views = new Map<string, WebContentsView>()

export function createWindow(): BrowserWindow {
  window = new BrowserWindow({
    width: 1280,
    height: 900,
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
    views.clear()
    activeWorktreeId = null
    window = null
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

  connectEditorCommandStream()
  return window
}

function connectEditorCommandStream(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const requestUrl = new URL('/editorCommands', SERVER_ORIGIN)
  const commandRequest = request(requestUrl, (response) => {
    response.setEncoding('utf8')
    let buffer = ''
    response.on('data', (chunk: string) => {
      buffer += chunk
      let delimiterIndex = buffer.indexOf('\n\n')
      while (delimiterIndex >= 0) {
        const rawEvent = buffer.slice(0, delimiterIndex)
        buffer = buffer.slice(delimiterIndex + 2)
        handleStreamEvent(rawEvent)
        delimiterIndex = buffer.indexOf('\n\n')
      }
    })
    response.on('end', scheduleReconnect)
  })

  commandRequest.on('error', (error) => {
    log.warn({ err: error }, 'editor command stream failed')
    scheduleReconnect()
  })
  commandRequest.end()
}

function handleStreamEvent(rawEvent: string): void {
  const lines = rawEvent.split('\n')
  const event = lines
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim()
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n')

  if (!data) {
    return
  }

  try {
    const command = JSON.parse(data) as EditorCommand
    if (event && event !== command.type) {
      log.warn({ event, command }, 'editor command event mismatch')
      return
    }
    handleEditorCommand(command)
  } catch (error) {
    log.error({ err: error, data }, 'failed to parse editor command')
  }
}

function handleEditorCommand(command: EditorCommand): void {
  if (command.type === 'switch') {
    switchWorktree(command)
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
  command: Extract<EditorCommand, { type: 'switch' }>,
): void {
  if (!window) {
    window = createWindow()
  }

  const view = getOrCreateWorktreeView(command)
  if (activeWorktreeId === command.worktreeId) {
    view.setVisible(true)
    window.show()
    window.focus()
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
  window.show()
  window.focus()
}

function getOrCreateWorktreeView(
  command: Extract<EditorCommand, { type: 'switch' }>,
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
    connectEditorCommandStream()
  }, 1000)
}
