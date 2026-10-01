import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from 'react'

export function usePickerNavigation(
  items: readonly { key: string; available: boolean }[],
  resultsKey: string,
  search: string,
  resetVersion: number,
  { focusOnWindowFocus = true }: { focusOnWindowFocus?: boolean } = {},
) {
  const rootRef = useRef<HTMLElement>(null)
  const entries = useRef(
    new Map<string, { row?: HTMLLIElement; button?: HTMLButtonElement }>(),
  )
  const order = useRef<string[]>([])
  const suspended = useRef(0)
  const [suspensionVersion, setSuspensionVersion] = useState(0)
  const availabilityKey = JSON.stringify(
    items.map(({ key, available }) => [key, available]),
  )
  useLayoutEffect(() => {
    order.current = items
      .filter((item) => item.available)
      .map((item) => item.key)
  }, [items])
  const register = useCallback(
    (
      key: string,
      kind: 'row' | 'button',
      element: HTMLLIElement | HTMLButtonElement | null,
    ) => {
      const entry = entries.current.get(key) ?? {}
      if (kind === 'row')
        entry.row = (element as HTMLLIElement | undefined) ?? undefined
      else
        entry.button = (element as HTMLButtonElement | undefined) ?? undefined
      if (entry.row || entry.button) entries.current.set(key, entry)
      else entries.current.delete(key)
    },
    [],
  )
  const targets = useCallback(
    () =>
      order.current.flatMap((key) => {
        const entry = entries.current.get(key)
        return entry?.button && !entry.button.disabled
          ? [{ key, ...entry, button: entry.button }]
          : []
      }),
    [],
  )
  const targetEntry = useCallback(
    (target: Element | null) =>
      targets().find(({ button }) => !!target && button.contains(target)),
    [targets],
  )
  const suspend = useCallback(() => {
    suspended.current++
    setSuspensionVersion((version) => version + 1)
    return () => {
      suspended.current--
      setSuspensionVersion((version) => version + 1)
    }
  }, [])
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

  const canOpenWithEnter = useCallback(
    (target: Element | null) => {
      return (
        target === searchRef.current ||
        (!!target &&
          !!listRef.current?.contains(target) &&
          targetEntry(target)?.button === target)
      )
    },
    [targetEntry],
  )

  const syncHighlightVisibility = useCallback(() => {
    setHighlightVisible(
      suspended.current === 0 &&
        (hovering.current ||
          (document.hasFocus() && canOpenWithEnter(document.activeElement))),
    )
  }, [canOpenWithEnter])

  const selectFirst = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const first = targets()[0]
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    first?.row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    hovering.current = false
    mode.current = 'keyboard'
    setHighlight({
      key: first?.key,
      mode: 'keyboard',
    })
    syncHighlightVisibility()
  }, [syncHighlightVisibility, targets])

  const mountList = useCallback(
    (element: HTMLUListElement | null) => {
      listRef.current = element
      // Dropdown content may mount after its owner has run layout effects.
      if (element) selectFirst()
    },
    [selectFirst],
  )

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    // Move focus off an old result before resetting selection, so Enter cannot
    // activate a row left over from the previous results.
    if (
      list.contains(document.activeElement) ||
      (document.activeElement === document.body &&
        document.hasFocus() &&
        suspended.current === 0)
    )
      searchRef.current?.focus({ preventScroll: true })
    selectFirst()
  }, [resultsKey, search, resetVersion, selectFirst])

  useLayoutEffect(() => {
    const buttons = targets()
    // Operations can enable or disable rows without changing the results.
    // Keep a valid selection in place, including during editor progress updates.
    if (buttons.some((button) => button.key === highlight.key)) return
    if (highlight.key !== buttons[0]?.key) selectFirst()
  }, [availabilityKey, highlight.key, selectFirst, targets])

  useLayoutEffect(() => {
    syncHighlightVisibility()
  }, [suspensionVersion, syncHighlightVisibility])

  useLayoutEffect(() => {
    const resetPointer = () => {
      pointer.current = null
      hovering.current = false
      syncHighlightVisibility()
    }
    const onFocus = () => {
      resetPointer()
      // A modal owns focus until it closes, including across window switches.
      if (suspended.current === 0 && focusOnWindowFocus) {
        searchRef.current?.focus({ preventScroll: true })
      }
      syncHighlightVisibility()
    }
    document.addEventListener('focusin', syncHighlightVisibility)
    document.addEventListener('focusout', syncHighlightVisibility)
    window.addEventListener('blur', resetPointer)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', resetPointer)
    return () => {
      document.removeEventListener('focusin', syncHighlightVisibility)
      document.removeEventListener('focusout', syncHighlightVisibility)
      window.removeEventListener('blur', resetPointer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', resetPointer)
    }
  }, [focusOnWindowFocus, syncHighlightVisibility])

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== 'mouse') return
    if (!event.currentTarget.contains(event.target as Node)) return
    const { screenX: x, screenY: y } = event
    const previous = pointer.current
    pointer.current = { x, y }
    // The first event after showing or entering only establishes a baseline.
    // Its movement delta can include travel while the picker was hidden.
    // Screen coordinates also ignore rows or the window moving under the cursor.
    if (!previous || (previous.x === x && previous.y === y)) return
    const button = targetEntry(event.target as Element)
    hovering.current = !!button
    syncHighlightVisibility()
    if (!button) return
    mode.current = 'mouse'
    setHighlight({ key: button.key, mode: 'mouse' })
  }

  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.defaultPrevented) return
      const workspace = rootRef.current
      if (suspended.current) return
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

      const buttons = targets()
      const current = buttons.findIndex(
        (button) => button.key === highlight.key,
      )
      if (
        (event.key === 'Enter' && canOpenWithEnter(target)) ||
        (event.key === ' ' && targetEntry(target)?.button === target)
      ) {
        // Hover alone does not enable keyboard activation.
        event.preventDefault()
        if (!event.repeat) buttons[current]?.button.click()
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
        setHighlight({ key: button.key, mode: 'keyboard' })
        if (!inSearch) button.button.focus({ preventScroll: true })
        button.row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    canOpenWithEnter,
    highlight,
    syncHighlightVisibility,
    targets,
    targetEntry,
  ])

  return {
    searchRef,
    scrollRef,
    register,
    suspend,
    highlight,
    tooltipDismissVersion,
    rootProps: {
      ref: rootRef,
      onPointerMove,
      onPointerLeave: () => {
        pointer.current = null
        hovering.current = false
        syncHighlightVisibility()
      },
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.target as Node)) return
        mode.current = 'mouse'
      },
    },
    listProps: {
      ref: mountList,
      'data-navigation': highlight.mode,
      'data-highlight-visible': highlightVisible,
      onFocus: (event: FocusEvent<HTMLUListElement>) => {
        const button = targetEntry(event.target)
        if (button) setHighlight({ key: button.key, mode: mode.current })
      },
    },
  }
}
