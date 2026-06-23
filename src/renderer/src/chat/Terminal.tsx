import { Terminal as XTerm } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { SERVER_ORIGIN } from '../../../api/server/config'
import {
  TerminalServerMessage,
  terminalSocketPath,
  type TerminalClientMessage,
} from '../../../api/server/terminals'
import { logger } from '../logger'
import { droppedFilePathInput, isFileDropItem } from './imageDrop'

// The terminal WebSocket shares the server origin, swapped to the ws scheme.
const WS_ORIGIN = SERVER_ORIGIN.replace(/^http/, 'ws')
const MINIMUM_COLS = 2
const MINIMUM_ROWS = 1
const COLUMN_FIT_GUARD_PX = 1
const RENDER_GUARD_COLS = 1

type TerminalFitDimensions = {
  cols: number
  renderCols: number
  rows: number
}

type XTermRenderService = {
  clear?: () => void
  dimensions?: {
    css?: {
      cell?: {
        width?: number
        height?: number
      }
    }
  }
}

type XTermWithCore = XTerm & {
  _core?: {
    _renderService?: XTermRenderService
  }
}

function terminalRenderService(term: XTerm): XTermRenderService | undefined {
  return (term as XTermWithCore)._core?._renderService
}

function cssPixels(style: CSSStyleDeclaration, property: string): number {
  const value = Number.parseFloat(style.getPropertyValue(property))
  return Number.isFinite(value) ? value : 0
}

function terminalViewport(term: XTerm): HTMLElement | null {
  return term.element?.querySelector<HTMLElement>('.xterm-viewport') ?? null
}

function measuredScrollbarWidth(term: XTerm): number {
  const viewport = terminalViewport(term)
  if (!viewport) {
    return 0
  }
  return Math.max(0, viewport.offsetWidth - viewport.clientWidth)
}

function proposeTerminalDimensions(
  term: XTerm,
): TerminalFitDimensions | null {
  const element = term.element
  const parent = element?.parentElement
  if (!element || !parent) {
    return null
  }

  const renderDimensions = terminalRenderService(term)?.dimensions
  const cellWidth = renderDimensions?.css?.cell?.width
  const cellHeight = renderDimensions?.css?.cell?.height
  if (
    !Number.isFinite(cellWidth) ||
    !Number.isFinite(cellHeight) ||
    !cellWidth ||
    !cellHeight
  ) {
    return null
  }

  const parentRect = parent.getBoundingClientRect()
  if (parentRect.width <= 0 || parentRect.height <= 0) {
    return null
  }

  const elementStyle = window.getComputedStyle(element)
  const horizontalPadding =
    cssPixels(elementStyle, 'padding-left') +
    cssPixels(elementStyle, 'padding-right')
  const verticalPadding =
    cssPixels(elementStyle, 'padding-top') +
    cssPixels(elementStyle, 'padding-bottom')

  const availableWidth =
    parentRect.width -
    horizontalPadding -
    measuredScrollbarWidth(term) -
    COLUMN_FIT_GUARD_PX
  const availableHeight = parentRect.height - verticalPadding
  if (availableWidth <= 0 || availableHeight <= 0) {
    return null
  }

  const renderCols = Math.max(
    MINIMUM_COLS + RENDER_GUARD_COLS,
    Math.floor(availableWidth / cellWidth),
  )
  // Keep one xterm-only column at the right edge. The PTY gets `cols`, while
  // xterm renders `renderCols`, so the logical last cell is not painted flush
  // against the canvas/scrollbar clipping boundary.
  return {
    cols: Math.max(MINIMUM_COLS, renderCols - RENDER_GUARD_COLS),
    renderCols,
    rows: Math.max(MINIMUM_ROWS, Math.floor(availableHeight / cellHeight)),
  }
}

function fitTerminal(term: XTerm): TerminalFitDimensions | null {
  const dimensions = proposeTerminalDimensions(term)
  if (!dimensions) {
    return null
  }
  if (term.cols !== dimensions.renderCols || term.rows !== dimensions.rows) {
    terminalRenderService(term)?.clear?.()
    term.resize(dimensions.renderCols, dimensions.rows)
  }
  return dimensions
}

/**
 * A single xterm terminal bound to a server-hosted PTY over a WebSocket. The
 * server replays the session's recent output on attach, so reopening the chat
 * window restores the screen. `active` triggers a safe refit when the tab is
 * shown.
 */
export function Terminal({
  terminalId,
  active,
  focusToken,
  onExit,
}: {
  terminalId: string
  active: boolean
  focusToken: number
  /** Called when the underlying PTY exits, so the tab can be closed. */
  onExit?: () => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const refitRef = useRef<(() => void) | null>(null)
  const sendInputRef = useRef<((data: string) => void) | null>(null)
  const [isDraggingImage, setIsDraggingImage] = useState(false)
  // A stable id for this mounted viewer (one per Terminal component instance,
  // not per connection). Stamped on every log line and sent to the server on the
  // socket URL so a post-mortem can tell one reconnecting viewer from two
  // instances dueling over the same terminal — `attempt` resets per mount and
  // can't, on its own, make that distinction. Lazy `useState` keeps it stable
  // for the instance's life without reading a ref during render.
  const [viewerId] = useState(() => crypto.randomUUID().slice(0, 8))
  // Keep the latest callback in a ref so the socket handler (bound once per
  // terminal) always calls the current one without re-running the effect.
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    // Mount/dispose bookends: with these, a server-side supersede war can be
    // attributed to a still-alive viewer (mounted, never disposed) vs. a clean
    // remount (disposed then a new viewerId mounts).
    logger.info({ terminalId, viewerId }, 'terminal viewer mounted')

    // How often the renderer pings the server, and how long it waits for a pong
    // before declaring the socket dead. A browser WebSocket reports `OPEN` even
    // for a connection that silently died while the laptop slept, so input is
    // written into a black hole; this heartbeat is the only way to notice and
    // reconnect. Reattaching is cheap — the server replays its output buffer.
    const PING_INTERVAL_MS = 5_000
    const PONG_TIMEOUT_MS = 12_000
    const RECONNECT_DELAY_MS = 1_000

    const term = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      scrollback: 1_000_000,
      theme: { background: '#111113' },
    })
    term.open(container)
    termRef.current = term

    // A single terminal reconnects across the life of this effect, so the socket
    // and its heartbeat timers are mutable. `disposed` guards against the
    // unmount cleanup racing a queued reconnect; `exited` stops reconnecting
    // once the PTY is gone for good; `yielded` stops it once a newer viewer has
    // taken over this terminal (the server told us we were superseded).
    let socket: WebSocket | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let pongTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    let exited = false
    let yielded = false
    // Monotonically increasing attempt id so server- and renderer-side logs of a
    // single reproduction can be lined up across a sleep/reconnect cycle.
    let generation = 0
    // Wall-clock of the previous heartbeat tick. The ping interval is frozen
    // while the laptop sleeps, so an oversized gap between ticks is a direct
    // fingerprint of a suspend/resume — the event that strands the socket.
    let lastTickAt: number | null = null

    const send = (message: TerminalClientMessage): void => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message))
      }
    }
    sendInputRef.current = (data) => send({ type: 'input', data })

    // Fit + report size only when the terminal is actually measurable. A hidden
    // or zero-size element must not be pushed to the PTY, since that would
    // reflow the CLI's UI into a useless tiny layout.
    const refit = (): void => {
      const dims = fitTerminal(term)
      if (
        !dims ||
        !Number.isFinite(dims.cols) ||
        !Number.isFinite(dims.rows) ||
        dims.cols < 2 ||
        dims.rows < 2
      ) {
        return
      }
      send({ type: 'resize', cols: dims.cols, rows: dims.rows })
    }
    refitRef.current = refit

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

    // Heartbeat: ping on an interval and arm a single pong deadline. A pong
    // clears the deadline; silence past it means the socket is dead (a half-open
    // connection left over from sleep), so tear it down and reconnect.
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

    // Drop the current socket without waiting for its (possibly never-firing)
    // close event, then queue a fresh attach.
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
          // Already closing or closed; nothing to do.
        }
        socket = null
      }
      scheduleReconnect()
    }

    const connect = (): void => {
      if (disposed || exited || yielded) {
        return
      }
      const attempt = ++generation
      logger.info({ terminalId, viewerId, attempt }, 'terminal connecting')
      // Rebuild the screen from the server's replayed buffer instead of
      // appending it beneath stale content from the previous connection.
      term.reset()
      const next = new WebSocket(
        `${WS_ORIGIN}${terminalSocketPath(terminalId, viewerId)}`,
      )
      socket = next
      next.onopen = () => {
        logger.info({ terminalId, viewerId, attempt }, 'terminal connected')
        startHeartbeat()
        refit()
      }
      next.onmessage = (event) => {
        let message
        try {
          const result = TerminalServerMessage.safeParse(
            JSON.parse(event.data as string),
          )
          if (!result.success) {
            logger.error({ err: result.error }, 'invalid terminal message')
            return
          }
          message = result.data
        } catch (error) {
          logger.error({ err: error }, 'failed to parse terminal message')
          return
        }
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
          onExitRef.current?.()
        } else if (message.type === 'superseded') {
          // Only honor this on the live socket: a stale socket we already
          // replaced (e.g. mid-reconnect) must not stop the viewer that owns the
          // current connection. The PTY is still alive — don't call onExit (that
          // closes the tab); just stop so we don't reconnect into a war.
          if (socket === next) {
            logger.info(
              { terminalId, viewerId, attempt },
              'terminal superseded by another viewer; yielding',
            )
            yielded = true
            stopHeartbeat()
          }
        }
      }
      next.onerror = () => {
        logger.warn({ terminalId, viewerId, attempt }, 'terminal socket error')
      }
      next.onclose = (event) => {
        if (socket === next) {
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
          stopHeartbeat()
          socket = null
          scheduleReconnect()
        }
      }
    }

    refit()
    connect()

    const onData = term.onData((data) => send({ type: 'input', data }))

    const observer = new ResizeObserver(() => refit())
    observer.observe(container)

    return () => {
      disposed = true
      logger.info({ terminalId, viewerId }, 'terminal viewer disposed')
      stopHeartbeat()
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      observer.disconnect()
      onData.dispose()
      if (socket) {
        socket.onclose = null
        socket.close()
      }
      term.dispose()
      termRef.current = null
      refitRef.current = null
      sendInputRef.current = null
    }
    // `viewerId` is stable for the life of this component instance, so listing it
    // never reconnects the socket; it is here only to satisfy exhaustive-deps.
  }, [terminalId, viewerId])

  // When this tab becomes active again or is explicitly selected, refit after
  // layout settles in case the window was resized while it was hidden, then put
  // keyboard focus back into xterm.
  useEffect(() => {
    if (!active) {
      return
    }
    const handle = requestAnimationFrame(() => {
      refitRef.current?.()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(handle)
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
