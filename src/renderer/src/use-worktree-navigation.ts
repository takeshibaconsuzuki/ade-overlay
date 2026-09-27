import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from 'react'

const openSelector = '.worktree-open:not(:disabled)'

export function useWorktreeNavigation(
  resultsKey: string,
  search: string,
  availabilityKey: string,
) {
  const listRef = useRef<HTMLUListElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [highlightVisible, setHighlightVisible] = useState(false)
  const [tooltipDismissVersion, setTooltipDismissVersion] = useState(0)
  const mode = useRef<'mouse' | 'keyboard'>('keyboard')
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const hovering = useRef(false)
  const [highlight, setHighlight] = useState<{
    key: string | undefined
    mode: 'mouse' | 'keyboard'
  }>({ key: undefined, mode: 'keyboard' })

  const canOpenWithEnter = useCallback((target: Element | null) => {
    return (
      target === searchRef.current ||
      (!!target &&
        !!listRef.current?.contains(target) &&
        target.matches(openSelector))
    )
  }, [])

  const syncHighlightVisibility = useCallback(() => {
    setHighlightVisible(
      !document.querySelector('[role="dialog"], [role="alertdialog"]') &&
        (hovering.current ||
          (document.hasFocus() && canOpenWithEnter(document.activeElement))),
    )
  }, [canOpenWithEnter])

  const selectFirst = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const first = list.querySelector<HTMLButtonElement>(openSelector)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    first
      ?.closest('li')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    hovering.current = false
    mode.current = 'keyboard'
    setHighlight({
      key: first?.dataset.worktreeKey,
      mode: 'keyboard',
    })
    syncHighlightVisibility()
  }, [syncHighlightVisibility])

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
  }, [resultsKey, search, selectFirst])

  useLayoutEffect(() => {
    const buttons = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(openSelector) ??
        []),
    ]
    // Operations can enable or disable rows without changing the results.
    // Keep a valid selection in place, including during editor progress updates.
    if (buttons.some((button) => button.dataset.worktreeKey === highlight.key))
      return
    if (highlight.key !== buttons[0]?.dataset.worktreeKey) selectFirst()
  }, [availabilityKey, highlight.key, selectFirst])

  useLayoutEffect(() => {
    const onFocus = () => {
      // A modal owns focus until it closes, including across window switches.
      if (!document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        searchRef.current?.focus({ preventScroll: true })
      }
      syncHighlightVisibility()
    }
    document.addEventListener('focusin', syncHighlightVisibility)
    document.addEventListener('focusout', syncHighlightVisibility)
    window.addEventListener('blur', syncHighlightVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('focusin', syncHighlightVisibility)
      document.removeEventListener('focusout', syncHighlightVisibility)
      window.removeEventListener('blur', syncHighlightVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [syncHighlightVisibility])

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== 'mouse') return
    if (!event.currentTarget.contains(event.target as Node)) return
    const { clientX: x, clientY: y } = event
    // Scrolling can move rows beneath the pointer without mouse input.
    if (
      mode.current === 'keyboard' &&
      pointer.current?.x === x &&
      pointer.current?.y === y
    )
      return
    pointer.current = { x, y }
    const button = (event.target as Element).closest<HTMLButtonElement>(
      openSelector,
    )
    hovering.current = !!button
    syncHighlightVisibility()
    if (!button) return
    mode.current = 'mouse'
    setHighlight({ key: button.dataset.worktreeKey, mode: 'mouse' })
  }

  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.defaultPrevented) return
      const workspace = listRef.current?.closest('.workspace')
      // Portalled dialogs keep their keys.
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
        setTooltipDismissVersion((version) => version + 1)
        mode.current = 'keyboard'
        hovering.current = false
        syncHighlightVisibility()
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
      if (
        (event.key === 'Enter' && canOpenWithEnter(target)) ||
        (event.key === ' ' && target.matches(openSelector))
      ) {
        // Hover alone does not enable keyboard activation.
        event.preventDefault()
        if (!event.repeat) buttons[current]?.click()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!buttons.length) return
        event.preventDefault()
        mode.current = 'keyboard'
        hovering.current = false
        syncHighlightVisibility()
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
        if (next !== current) setTooltipDismissVersion((version) => version + 1)
        setHighlight({ key: button.dataset.worktreeKey, mode: 'keyboard' })
        if (!inSearch) button.focus({ preventScroll: true })
        button
          .closest('li')
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canOpenWithEnter, highlight, syncHighlightVisibility])

  return {
    searchRef,
    scrollRef,
    highlight,
    tooltipDismissVersion,
    workspaceProps: {
      onPointerMove,
      onPointerLeave: () => {
        hovering.current = false
        syncHighlightVisibility()
      },
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.target as Node)) return
        mode.current = 'mouse'
      },
    },
    listProps: {
      ref: listRef,
      'data-navigation': highlight.mode,
      'data-highlight-visible': highlightVisible,
      onFocus: (event: FocusEvent<HTMLUListElement>) => {
        const button = event.target.closest<HTMLButtonElement>(openSelector)
        if (button)
          setHighlight({ key: button.dataset.worktreeKey, mode: mode.current })
      },
    },
  }
}
