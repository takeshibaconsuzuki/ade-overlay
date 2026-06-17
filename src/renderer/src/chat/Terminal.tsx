import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import {
  chatTerminalSocketPath,
  type ChatTerminalClientMessage,
  type ChatTerminalServerMessage,
} from '../../../api/server/chats'
import { SERVER_ORIGIN } from '../../../api/server/config'
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

    const socket = new WebSocket(
      `${WS_ORIGIN}${chatTerminalSocketPath(terminalId)}`,
    )

    const send = (message: ChatTerminalClientMessage): void => {
      if (socket.readyState === WebSocket.OPEN) {
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
    refit()

    socket.onopen = refit
    socket.onmessage = (event) => {
      let message: ChatTerminalServerMessage
      try {
        message = JSON.parse(event.data as string) as ChatTerminalServerMessage
      } catch (error) {
        logger.error({ err: error }, 'failed to parse terminal message')
        return
      }
      if (message.type === 'output') {
        term.write(message.data)
      } else if (message.type === 'exit') {
        onExitRef.current?.()
      }
    }
    socket.onerror = () => {
      logger.warn({ terminalId }, 'terminal socket error')
    }

    const onData = term.onData((data) => send({ type: 'input', data }))

    const observer = new ResizeObserver(() => refit())
    observer.observe(container)

    return () => {
      observer.disconnect()
      onData.dispose()
      socket.close()
      term.dispose()
      refitRef.current = null
    }
  }, [terminalId])

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
