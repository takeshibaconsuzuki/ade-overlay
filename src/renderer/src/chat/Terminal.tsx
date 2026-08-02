import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { SERVER_ORIGIN } from '../../../api/server/config'
import { openFileInEditor } from '../../../api/server/generated'
import {
  TerminalServerMessage,
  terminalSocketPath,
  type TerminalClientMessage,
} from '../../../api/server/terminals'
import { logger } from '../logger'
import { droppedFilePathInput, isFileDropItem } from './imageDrop'
import styles from './Terminal.module.css'
import {
  hasTerminalLinkModifier,
  isMacTerminalPlatform,
  terminalFileLinkProvider,
  type TerminalFileLink,
} from './terminalFileLinks'

const WS_ORIGIN = SERVER_ORIGIN.replace(/^http/, 'ws')
const PING_INTERVAL_MS = 5_000
const PONG_TIMEOUT_MS = 12_000
const RECONNECT_DELAY_MS = 1_000

type TerminalSize = {
  cols: number
  rows: number
}

/**
 * A single xterm terminal bound to a server-hosted PTY over a WebSocket. The
 * server replays the session's recent output on attach, so reopening the chat
 * window restores the screen. `active` refits and focuses the selected tab.
 */
export function Terminal({
  terminalId,
  worktreeId,
  active,
  focusToken,
  onExit,
}: {
  terminalId: string
  worktreeId: string
  active: boolean
  focusToken: number
  onExit?: () => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const refitRef = useRef<(() => void) | null>(null)
  const sendInputRef = useRef<((data: string) => void) | null>(null)
  const onExitRef = useRef(onExit)
  const [isDraggingImage, setIsDraggingImage] = useState(false)
  const [viewerId] = useState(() => crypto.randomUUID().slice(0, 8))

  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    logger.info({ terminalId, viewerId }, 'terminal viewer mounted')

    const isMac = isMacTerminalPlatform(navigator.platform)
    const term = new XTerm({
      cursorBlink: false,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      linkHandler: {
        activate: (event, url) => openExternalUrl(event, url),
      },
      scrollback: 1_000_000,
      theme: { background: '#111113' },
    })
    function restoreTerminalLinkHover(): void {
      requestAnimationFrame(() => {
        term.refresh(0, term.rows - 1)
      })
    }
    function openExternalUrl(event: MouseEvent, url: string): void {
      if (!hasTerminalLinkModifier(event, isMac)) {
        restoreTerminalLinkHover()
        return
      }
      void window.desktop.openExternalUrl(url).catch((error: unknown) => {
        logger.warn(
          { err: error, terminalId, url },
          'failed to request opening terminal link',
        )
      })
    }
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon((event, url) =>
      openExternalUrl(event, url),
    )
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    const fileLinks = term.registerLinkProvider(
      terminalFileLinkProvider(term, (event, link: TerminalFileLink) => {
        if (!hasTerminalLinkModifier(event, isMac)) {
          restoreTerminalLinkHover()
          return
        }
        void openFileInEditor({
          body: {
            worktreeId,
            filePath: link.filePath,
            line: link.line,
            column: link.column,
          },
        })
          .then(({ error }) => {
            if (error) {
              logger.warn(
                { err: error, terminalId, worktreeId, filePath: link.filePath },
                'failed to open terminal file link',
              )
            }
          })
          .catch((error: unknown) => {
            logger.warn(
              { err: error, terminalId, worktreeId, filePath: link.filePath },
              'failed to request opening terminal file link',
            )
          })
      }),
    )
    term.open(container)
    termRef.current = term

    const updateLinkModifier = (event: KeyboardEvent | MouseEvent): void => {
      container.classList.toggle(
        styles.linkModifierPressed,
        hasTerminalLinkModifier(event, isMac),
      )
    }
    const clearLinkModifier = (): void => {
      container.classList.remove(styles.linkModifierPressed)
    }
    window.addEventListener('keydown', updateLinkModifier)
    window.addEventListener('keyup', updateLinkModifier)
    window.addEventListener('blur', clearLinkModifier)
    container.addEventListener('mousemove', updateLinkModifier)

    const copySelection = async (): Promise<void> => {
      if (!term.hasSelection()) {
        return
      }
      try {
        await navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
      } catch (error) {
        logger.warn({ err: error, terminalId }, 'failed to copy terminal text')
      }
    }

    const pasteClipboard = async (): Promise<void> => {
      try {
        const text = await navigator.clipboard.readText()
        if (text) {
          term.paste(text)
        }
        term.focus()
      } catch (error) {
        logger.warn({ err: error, terminalId }, 'failed to paste terminal text')
      }
    }

    term.attachCustomKeyEventHandler((event) => {
      const isCopyShortcut =
        event.type === 'keydown' &&
        event.key.toLowerCase() === 'c' &&
        (event.ctrlKey || event.metaKey) &&
        term.hasSelection()
      if (!isCopyShortcut) {
        return true
      }

      event.preventDefault()
      void copySelection()
      return false
    })

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      if (term.hasSelection()) {
        void copySelection()
      } else {
        void pasteClipboard()
      }
    }
    term.element?.addEventListener('contextmenu', onContextMenu)

    let socket: WebSocket | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let pongTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let fitFrame: number | null = null
    let lastSentSize: TerminalSize | null = null
    let disposed = false
    let exited = false
    let yielded = false
    let generation = 0
    let lastTickAt: number | null = null

    const send = (message: TerminalClientMessage): boolean => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false
      }
      socket.send(JSON.stringify(message))
      return true
    }
    sendInputRef.current = (data) => {
      send({ type: 'input', data })
    }

    const fitAndResizePty = (): void => {
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return
      }

      fitAddon.fit()
      const size = { cols: term.cols, rows: term.rows }
      if (size.cols < 2 || size.rows < 2) {
        return
      }
      if (lastSentSize?.cols === size.cols && lastSentSize.rows === size.rows) {
        return
      }
      if (send({ type: 'resize', ...size })) {
        lastSentSize = size
      }
    }
    refitRef.current = fitAndResizePty

    const scheduleFit = (): void => {
      if (disposed || fitFrame !== null) {
        return
      }
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null
        fitAndResizePty()
      })
    }

    const stopHeartbeat = (): void => {
      if (pingTimer !== null) {
        clearInterval(pingTimer)
        pingTimer = null
      }
      if (pongTimer !== null) {
        clearTimeout(pongTimer)
        pongTimer = null
      }
    }

    const scheduleReconnect = (): void => {
      if (disposed || exited || yielded || reconnectTimer !== null) {
        return
      }
      logger.info(
        { terminalId, viewerId, delayMs: RECONNECT_DELAY_MS },
        'terminal reconnect scheduled',
      )
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, RECONNECT_DELAY_MS)
    }

    const forceReconnect = (): void => {
      stopHeartbeat()
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        try {
          socket.close()
        } catch {
          // The socket is already closing or closed.
        }
        socket = null
      }
      scheduleReconnect()
    }

    const startHeartbeat = (): void => {
      stopHeartbeat()
      lastTickAt = null
      pingTimer = setInterval(() => {
        const now = Date.now()
        if (lastTickAt !== null && now - lastTickAt > PING_INTERVAL_MS * 2) {
          logger.info(
            { terminalId, viewerId, gapMs: now - lastTickAt },
            'terminal heartbeat gap detected (likely system suspend/resume)',
          )
        }
        lastTickAt = now
        send({ type: 'ping' })
        if (pongTimer === null) {
          pongTimer = setTimeout(() => {
            logger.warn(
              { terminalId, viewerId, timeoutMs: PONG_TIMEOUT_MS },
              'terminal heartbeat timed out; forcing reconnect',
            )
            forceReconnect()
          }, PONG_TIMEOUT_MS)
        }
      }, PING_INTERVAL_MS)
    }

    const connect = (): void => {
      if (disposed || exited || yielded) {
        return
      }
      const attempt = ++generation
      logger.info({ terminalId, viewerId, attempt }, 'terminal connecting')

      term.reset()
      const next = new WebSocket(
        `${WS_ORIGIN}${terminalSocketPath(terminalId, viewerId)}`,
      )
      socket = next

      next.onopen = () => {
        logger.info({ terminalId, viewerId, attempt }, 'terminal connected')
        startHeartbeat()
        scheduleFit()
      }
      next.onmessage = (event) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(event.data as string)
        } catch (error) {
          logger.error({ err: error }, 'failed to parse terminal message')
          return
        }

        const result = TerminalServerMessage.safeParse(parsed)
        if (!result.success) {
          logger.error({ err: result.error }, 'invalid terminal message')
          return
        }
        const message = result.data
        if (message.type === 'output') {
          term.write(message.data)
        } else if (message.type === 'pong') {
          if (pongTimer !== null) {
            clearTimeout(pongTimer)
            pongTimer = null
          }
        } else if (message.type === 'exit') {
          logger.info({ terminalId, viewerId, attempt }, 'terminal exited')
          exited = true
          stopHeartbeat()
          onExitRef.current?.()
        } else if (message.type === 'superseded' && socket === next) {
          logger.info(
            { terminalId, viewerId, attempt },
            'terminal superseded by another viewer; yielding',
          )
          yielded = true
          stopHeartbeat()
        }
      }
      next.onerror = () => {
        logger.warn({ terminalId, viewerId, attempt }, 'terminal socket error')
      }
      next.onclose = (event) => {
        logger.info(
          {
            terminalId,
            viewerId,
            attempt,
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          },
          'terminal socket closed',
        )
        if (socket === next) {
          stopHeartbeat()
          socket = null
          scheduleReconnect()
        }
      }
    }

    const onData = term.onData((data) => {
      send({ type: 'input', data })
    })
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)

    scheduleFit()
    connect()

    return () => {
      disposed = true
      logger.info({ terminalId, viewerId }, 'terminal viewer disposed')
      stopHeartbeat()
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
      }
      if (fitFrame !== null) {
        cancelAnimationFrame(fitFrame)
      }
      observer.disconnect()
      onData.dispose()
      window.removeEventListener('keydown', updateLinkModifier)
      window.removeEventListener('keyup', updateLinkModifier)
      window.removeEventListener('blur', clearLinkModifier)
      container.removeEventListener('mousemove', updateLinkModifier)
      term.element?.removeEventListener('contextmenu', onContextMenu)
      fileLinks.dispose()
      if (socket) {
        socket.onclose = null
        socket.close()
      }
      term.dispose()
      termRef.current = null
      refitRef.current = null
      sendInputRef.current = null
    }
  }, [terminalId, viewerId, worktreeId])

  useEffect(() => {
    if (!active) {
      return
    }
    const frame = requestAnimationFrame(() => {
      refitRef.current?.()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, focusToken])

  const dropFiles = useCallback((files: FileList): void => {
    const input = droppedFilePathInput([...files], (file) => {
      try {
        return window.desktop.getPathForFile(file)
      } catch (error) {
        logger.warn({ err: error }, 'failed to resolve dropped file path')
        return ''
      }
    })
    if (!input) {
      return
    }
    termRef.current?.focus()
    sendInputRef.current?.(input)
  }, [])

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (![...event.dataTransfer.items].some(isFileDropItem)) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setIsDraggingImage(true)
    },
    [],
  )

  const onDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setIsDraggingImage(false)
      }
    },
    [],
  )

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      setIsDraggingImage(false)
      if (event.dataTransfer.files.length === 0) {
        return
      }
      event.preventDefault()
      dropFiles(event.dataTransfer.files)
    },
    [dropFiles],
  )

  return (
    <div
      ref={containerRef}
      className={styles.root}
      data-terminal-id={terminalId}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        width: '100%',
        height: '100%',
        outline: isDraggingImage ? '2px solid var(--accent-9)' : undefined,
        outlineOffset: isDraggingImage ? '-2px' : undefined,
      }}
    />
  )
}
