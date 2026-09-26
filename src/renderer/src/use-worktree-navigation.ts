import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from 'react'

const openSelector = '.worktree-open:not(:disabled)'

export function useWorktreeNavigation(resultsKey: string) {
  const listRef = useRef<HTMLUListElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [highlightVisible, setHighlightVisible] = useState(() =>
    document.hasFocus(),
  )
  const mode = useRef<'mouse' | 'keyboard'>('keyboard')
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const [highlight, setHighlight] = useState<{
    key: string | undefined
    mode: 'mouse' | 'keyboard'
  }>({ key: undefined, mode: 'keyboard' })

  const selectFirst = useCallback(() => {
    const list = listRef.current
    if (!list) return
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    mode.current = 'keyboard'
    setHighlight({
      key: list.querySelector<HTMLButtonElement>(openSelector)?.dataset
        .worktreeKey,
      mode: 'keyboard',
    })
    setHighlightVisible(document.hasFocus())
  }, [])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    // Move focus off an old result before resetting selection, so Enter cannot
    // activate a row left over from the previous results.
    if (
      list.contains(document.activeElement) ||
      (document.activeElement === document.body &&
        document.hasFocus() &&
        !document.querySelector('[role="dialog"], [role="alertdialog"]'))
    )
      searchRef.current?.focus({ preventScroll: true })
    selectFirst()
  }, [resultsKey, selectFirst])

  useLayoutEffect(() => {
    const onBlur = () => setHighlightVisible(false)
    const onFocus = () => {
      // A modal owns focus until it closes, including across window switches.
      if (!document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        searchRef.current?.focus({ preventScroll: true })
        // The field may already own DOM focus when the window reactivates.
        selectFirst()
      }
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [selectFirst])

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== 'mouse') return
    if (!document.hasFocus()) return
    if (!event.currentTarget.contains(event.target as Node)) return
    if (event.target === searchRef.current) return
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
      if (event.isComposing || event.defaultPrevented) return
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
      const inSearch = target === searchRef.current
      if (
        !inSearch &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return

      const buttons = [
        ...list.querySelectorAll<HTMLButtonElement>(openSelector),
      ]
      const current = buttons.findIndex(
        (button) => button.dataset.worktreeKey === highlight.key,
      )
      if (inSearch && event.key === 'Enter') {
        event.preventDefault()
        if (!event.repeat) (buttons[current] ?? buttons[0])?.click()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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
        if (!inSearch) button.focus({ preventScroll: true })
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
    searchRef,
    scrollRef,
    onSearchFocus: selectFirst,
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
