import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export function StartCommandTerminal({
  active,
  visible,
  onInitialized,
}: {
  active: boolean
  visible: boolean
  onInitialized: (enabled: boolean) => void
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const element = container.current!
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#111113', foreground: '#eeeeef' },
    })
    const addon = new FitAddon()
    term.loadAddon(addon)
    term.open(element)
    terminal.current = term
    fit.current = addon
    let initialized = false
    window.picker.setOnStartCommandDataListener((data) => {
      if (initialized) term.write(data)
    })
    window.picker.setOnStartCommandInitializedListener((history) => {
      initialized = true
      if (history !== null) term.write(history)
      onInitialized(history !== null)
    })
    const input = term.onData((data) => window.picker.writeStartCommand(data))
    const resize = term.onResize(({ cols, rows }) =>
      window.picker.resizeStartCommand(cols, rows),
    )
    const observer = new ResizeObserver(() => {
      if (element.clientWidth && element.clientHeight) addon.fit()
    })
    observer.observe(element)
    window.picker.initializeStartCommand()
    return () => {
      window.picker.setOnStartCommandDataListener(undefined)
      window.picker.setOnStartCommandInitializedListener(undefined)
      observer.disconnect()
      input.dispose()
      resize.dispose()
      term.dispose()
      terminal.current = null
      fit.current = null
    }
  }, [onInitialized])

  useLayoutEffect(() => {
    if (active && visible) {
      fit.current?.fit()
      terminal.current?.focus()
    }
  }, [active, visible])

  return (
    <div
      className="start-command-terminal"
      hidden={!active}
      aria-label="Start command terminal"
      ref={container}
    />
  )
}
