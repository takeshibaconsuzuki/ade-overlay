import {
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from 'react'

const openSelector = '.worktree-open:not(:disabled)'

export function useWorktreeNavigation() {
  const listRef = useRef<HTMLUListElement>(null)
  const [highlightVisible, setHighlightVisible] = useState(() =>
    document.hasFocus(),
  )
  const mode = useRef<'mouse' | 'keyboard'>('keyboard')
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const [highlight, setHighlight] = useState<{
    key: string | undefined
    mode: 'mouse' | 'keyboard'
  }>({ key: undefined, mode: 'keyboard' })

  useLayoutEffect(() => {
    // Returning to the window restores DOM focus, but only fresh input should
    // restore the row highlight. Keep its key so arrows resume from that row.
    const onBlur = () => setHighlightVisible(false)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== 'mouse') return
    if (!document.hasFocus()) return
    if (!event.currentTarget.contains(event.target as Node)) return
    const { clientX: x, clientY: y } = event
    // Scrolling can move rows beneath the pointer without mouse input.
    if (
      (mode.current === 'keyboard' || !highlightVisible) &&
      pointer.current?.x === x &&
      pointer.current?.y === y
    )
      return
    pointer.current = { x, y }
    mode.current = 'mouse'
    setHighlightVisible(true)
    const button = (event.target as Element).closest<HTMLButtonElement>(
      openSelector,
    )
    setHighlight({ key: button?.dataset.worktreeKey, mode: 'mouse' })
  }

  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const workspace = listRef.current?.closest('.workspace')
      // Hover must work before anything is focused; portalled dialogs keep their keys.
      if (
        event.target !== document.body &&
        !workspace?.contains(event.target as Node)
      )
        return
      if (
        event.key === 'Tab' &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        mode.current = 'keyboard'
        setHighlightVisible(true)
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return
      const list = listRef.current
      if (!list) return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]'))
        return

      const buttons = [
        ...list.querySelectorAll<HTMLButtonElement>(openSelector),
      ]
      const current = buttons.findIndex(
        (button) => button.dataset.worktreeKey === highlight.key,
      )
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!buttons.length) return
        event.preventDefault()
        mode.current = 'keyboard'
        setHighlightVisible(true)
        const next =
          current < 0
            ? event.key === 'ArrowDown'
              ? 0
              : buttons.length - 1
            : Math.max(
                0,
                Math.min(
                  buttons.length - 1,
                  current + (event.key === 'ArrowDown' ? 1 : -1),
                ),
              )
        const button = buttons[next]
        setHighlight({ key: button.dataset.worktreeKey, mode: 'keyboard' })
        button.focus({ preventScroll: true })
        button
          .closest('li')
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      } else if (
        (event.key === 'Enter' || event.key === ' ') &&
        target.matches(openSelector) &&
        highlight.mode === 'mouse' &&
        current >= 0
      ) {
        // Mouse hover may have moved the highlight away from the focused button.
        event.preventDefault()
        if (!event.repeat) buttons[current].click()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [highlight])

  return {
    highlight,
    workspaceProps: {
      onPointerMove,
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.target as Node)) return
        mode.current = 'mouse'
        setHighlightVisible(true)
      },
      onPointerLeave: () => {
        if (mode.current === 'mouse')
          setHighlight({ key: undefined, mode: 'mouse' })
      },
    },
    listProps: {
      ref: listRef,
      'data-navigation': highlight.mode,
      'data-highlight-visible': highlightVisible,
      onFocus: (event: FocusEvent<HTMLUListElement>) => {
        const button = event.target.closest<HTMLButtonElement>(openSelector)
        setHighlight({ key: button?.dataset.worktreeKey, mode: mode.current })
      },
      onBlur: (event: FocusEvent<HTMLUListElement>) => {
        if (
          document.hasFocus() &&
          !event.currentTarget.contains(event.relatedTarget) &&
          mode.current === 'keyboard'
        ) {
          setHighlight({ key: undefined, mode: 'keyboard' })
        }
      },
    },
  }
}
