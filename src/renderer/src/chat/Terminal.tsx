import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { SERVER_ORIGIN } from '../../../api/server/config'
import {
  TerminalServerMessage,
  terminalSocketPath,
  type TerminalClientMessage,
} from '../../../api/server/terminals'
import { logger } from '../logger'

// The terminal WebSocket shares the server origin, swapped to the ws scheme.
const WS_ORIGIN = SERVER_ORIGIN.replace(/^http/, 'ws')

/**
 * A single xterm terminal bound to a server-hosted PTY over a WebSocket. The
 * server replays the session's recent output on attach, so reopening the chat
 * window restores the screen. `active` triggers a safe refit when the tab is
 * shown.
 */
export function Terminal({
  terminalId,
  active,
  onExit,
}: {
  terminalId: string
  active: boolean
  /** Called when the underlying PTY exits, so the tab can be closed. */
  onExit?: () => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const refitRef = useRef<(() => void) | null>(null)
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
      // Effectively unlimited history so output is never trimmed before the
      // underlying agent runs out of context. This is a memory ceiling, not an
      // up-front cost: scripts/patch-xterm-scrollback.mjs makes xterm's buffer
      // grow lazily, so a quiet terminal pays ~nothing and only a genuinely
      // full 1M-line scrollback approaches the cap. Keep it finite: Infinity
      // would disable xterm's trim-on-full logic and let the buffer grow without
      // bound.
      scrollback: 1_000_000_000,
      theme: { background: '#111113' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

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

    // Fit + report size only when the terminal is actually measurable. A hidden
    // or zero-size element makes the fit addon propose a 1-column layout; pushing
    // that to the PTY would reflow the CLI's UI into a useless single column.
    const refit = (): void => {
      const dims = fit.proposeDimensions()
      if (
        !dims ||
        !Number.isFinite(dims.cols) ||
        !Number.isFinite(dims.rows) ||
        dims.cols < 2 ||
        dims.rows < 2
      ) {
        return
      }
      fit.fit()
      send({ type: 'resize', cols: term.cols, rows: term.rows })
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
      refitRef.current = null
    }
    // `viewerId` is stable for the life of this component instance, so listing it
    // never reconnects the socket; it is here only to satisfy exhaustive-deps.
  }, [terminalId, viewerId])

  // When this tab becomes active again, refit after layout settles in case the
  // window was resized while it was hidden.
  useEffect(() => {
    if (!active) {
      return
    }
    const handle = requestAnimationFrame(() => refitRef.current?.())
    return () => cancelAnimationFrame(handle)
  }, [active])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
