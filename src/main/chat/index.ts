import { request } from 'node:http'
import { BrowserWindow, ipcMain } from 'electron'
import { ADE_APP_ROLE, APP_FOCUS_EVENT } from '../../api/server/appFocus'
import {
  CHAT_COMMAND_STREAM_PATH,
  CHAT_READY_PATH,
  ChatCommandSseEvents,
  type ChatCommand,
} from '../../api/server/chats'
import { SERVER_ORIGIN } from '../../api/server/config'
import { logger } from '../../server/logger'
import { reportAppFocus } from '../appFocus'
import { loadRenderer, webPreferences } from '../browser'
import { MAIN_IPC_CHANNELS } from '../ipc-channels'
import { connectSseClient } from '../sse'
import { showWindowOnCurrentWorkspace } from '../windowFocus'

const log = logger.child({ process: 'chat' })

/** Matches the dark theme's base surface so the window never flashes white. */
const WINDOW_BACKGROUND = '#111113'

let window: BrowserWindow | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let commandStreamReady: Promise<void> | null = null
let rendererReady = false
let readyPosted = false

export function registerChatIpcHandlers(): void {
  ipcMain.handle(MAIN_IPC_CHANNELS.chatRendererReady, () => {
    rendererReady = true
    void postReadyIfPossible()
  })
}

/**
 * Creates the chat window: a separate-role app that hosts the terminals running
 * chat sessions. It listens to the server's chat command stream so `show`
 * reveals the window and `focus` brings it forward.
 */
export function createWindow(): BrowserWindow {
  window = new BrowserWindow({
    width: 1200,
    height: 800,
    acceptFirstMouse: true,
    show: false,
    title: 'ADE Chat',
    backgroundColor: WINDOW_BACKGROUND,
    frame: false,
    webPreferences: webPreferences(),
  })

  window.on('closed', () => {
    log.info('chat window closed')
    reportAppFocus(ADE_APP_ROLE.chat, APP_FOCUS_EVENT.closed, log)
    rendererReady = false
    window = null
  })
  window.on('focus', () => {
    reportAppFocus(ADE_APP_ROLE.chat, APP_FOCUS_EVENT.focused, log)
  })

  loadRenderer(window, 'chat')

  void connectChatCommandStream().catch(() => undefined)
  return window
}

function connectChatCommandStream(): Promise<void> {
  if (commandStreamReady) {
    return commandStreamReady
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const requestUrl = new URL(CHAT_COMMAND_STREAM_PATH, SERVER_ORIGIN)
  commandStreamReady = new Promise<void>((resolve, reject) => {
    let opened = false
    connectSseClient({
      log,
      onEnd: () => {
        commandStreamReady = null
        if (!opened) {
          reject(new Error('chat command stream ended before opening'))
        }
        scheduleReconnect()
      },
      onError: (error) => {
        commandStreamReady = null
        if (!opened) {
          reject(error)
        }
        log.warn({ err: error }, 'chat command stream failed')
        scheduleReconnect()
      },
      onMessage: (message) => handleChatCommand(message.data),
      onOpen: (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          const error = new Error('chat command stream rejected')
          commandStreamReady = null
          log.warn(
            { statusCode: response.statusCode },
            'chat command stream rejected',
          )
          reject(error)
          return
        }
        opened = true
        resolve()
        void postReadyIfPossible()
      },
      schemas: ChatCommandSseEvents,
      stream: 'chat-command',
      url: requestUrl,
    })
  })
  return commandStreamReady
}

function handleChatCommand(command: ChatCommand): void {
  if (command.type === 'show') {
    showChatWindow()
    return
  }

  if (command.type !== 'focus') {
    log.warn({ command }, 'unknown chat command')
    return
  }

  focusChatWindow()
  if ('terminalId' in command) {
    sendRendererCommand(command)
  }
}

function showChatWindow(): void {
  if (!window || window.isDestroyed()) {
    window = createWindow()
  }
  showWindowOnCurrentWorkspace(window, { focus: false })
}

function focusChatWindow(): void {
  if (!window || window.isDestroyed()) {
    window = createWindow()
  }
  showWindowOnCurrentWorkspace(window, { focus: true })
}

function sendRendererCommand(command: ChatCommand): void {
  if (!rendererReady || !window || window.webContents.isDestroyed()) {
    log.warn(
      { command },
      'targeted chat command received before renderer ready',
    )
    return
  }
  window.webContents.send(MAIN_IPC_CHANNELS.chatCommand, command)
}

async function postReadyIfPossible(): Promise<void> {
  if (readyPosted || !rendererReady || !commandStreamReady) {
    return
  }
  const streamReady = commandStreamReady
  try {
    await streamReady
  } catch {
    return
  }
  if (streamReady !== commandStreamReady || readyPosted || !rendererReady) {
    return
  }

  const launchId = process.env.ADE_CHAT_LAUNCH_ID
  if (!launchId) {
    log.warn('chat launch id is missing; readiness not posted')
    return
  }

  readyPosted = true
  const body = JSON.stringify({ launchId })
  const readyRequest = request(
    new URL(CHAT_READY_PATH, SERVER_ORIGIN),
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
          'chat readiness rejected',
        )
      }
      response.resume()
    },
  )
  readyRequest.on('error', (error) => {
    readyPosted = false
    log.warn({ err: error, launchId }, 'failed to post chat readiness')
  })
  readyRequest.end(body)
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectChatCommandStream().catch(() => undefined)
  }, 1000)
}
