import { request } from 'node:http'
import { BrowserWindow } from 'electron'
import { ADE_APP_ROLE, APP_FOCUS_EVENT } from '../../api/server/appFocus'
import { CHAT_COMMAND_STREAM_PATH } from '../../api/server/chats'
import { SERVER_ORIGIN } from '../../api/server/config'
import { logger } from '../../server/logger'
import { reportAppFocus } from '../appFocus'
import { loadRenderer, webPreferences } from '../browser'

const log = logger.child({ process: 'chat' })

/** Matches the dark theme's base surface so the window never flashes white. */
const WINDOW_BACKGROUND = '#111113'

let window: BrowserWindow | null = null
let reconnectTimer: NodeJS.Timeout | null = null

/**
 * Creates the chat window: a separate-role app that hosts the terminals running
 * chat sessions. It listens to the server's chat command stream so a `show`
 * (emitted when the launcher's `c` key opens the app) brings it forward.
 */
export function createWindow(): BrowserWindow {
  window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: 'ADE Chat',
    backgroundColor: WINDOW_BACKGROUND,
    frame: false,
    webPreferences: webPreferences(),
  })

  window.on('closed', () => {
    log.info('chat window closed')
    reportAppFocus(ADE_APP_ROLE.chat, APP_FOCUS_EVENT.closed, log)
    window = null
  })
  window.on('focus', () => {
    reportAppFocus(ADE_APP_ROLE.chat, APP_FOCUS_EVENT.focused, log)
  })

  loadRenderer(window, 'chat')

  connectChatCommandStream()
  return window
}

function connectChatCommandStream(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const requestUrl = new URL(CHAT_COMMAND_STREAM_PATH, SERVER_ORIGIN)
  const commandRequest = request(requestUrl, (response) => {
    response.setEncoding('utf8')
    let buffer = ''
    response.on('data', (chunk: string) => {
      buffer += chunk
      let delimiterIndex = buffer.indexOf('\n\n')
      while (delimiterIndex >= 0) {
        handleStreamEvent(buffer.slice(0, delimiterIndex))
        buffer = buffer.slice(delimiterIndex + 2)
        delimiterIndex = buffer.indexOf('\n\n')
      }
    })
    response.on('end', scheduleReconnect)
  })

  commandRequest.on('error', (error) => {
    log.warn({ err: error }, 'chat command stream failed')
    scheduleReconnect()
  })
  commandRequest.end()
}

function handleStreamEvent(rawEvent: string): void {
  const event = rawEvent
    .split('\n')
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim()

  // The window only needs to come forward; the renderer reads the same stream
  // for the command's worktree to scope its sidebar.
  if (event === 'show') {
    bringForward()
  }
}

function bringForward(): void {
  if (!window || window.isDestroyed()) {
    window = createWindow()
  }
  window.show()
  window.focus()
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectChatCommandStream()
  }, 1000)
}
