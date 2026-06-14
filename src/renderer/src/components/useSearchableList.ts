import { useCallback, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefCallback } from 'react'

export type SearchableItemProps = {
  role: 'option'
  'aria-selected': boolean
  'data-active': boolean
  ref: RefCallback<HTMLElement>
  onMouseMove: () => void
  onClick: () => void
}

export type UseSearchableListOptions<T> = {
  /** The full, unfiltered set of items. */
  items: readonly T[]
  /**
   * Text used both to filter against the query and to drive matching. Pass a
   * stable (memoized) function to avoid recomputing the filtered list.
   */
  getText: (item: T) => string
  /** The current search query. */
  query: string
  /** Invoked when an item is chosen via Enter or click. */
  onSelect?: (item: T, index: number) => void
}

export type UseSearchableListResult<T> = {
  /** Items matching the query, in their original order. */
  filtered: T[]
  /** Index of the active item within `filtered`, or -1 when empty. */
  activeIndex: number
  setActiveIndex: (index: number) => void
  /** Attach to the input (or container) that owns keyboard focus. */
  onKeyDown: (event: KeyboardEvent) => void
  /** Spread onto each rendered item to wire selection, hover, and a11y. */
  getItemProps: (index: number) => SearchableItemProps
}

/** Nearest ancestor that scrolls vertically, if any. */
function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null
  while (current) {
    const overflowY = getComputedStyle(current).overflowY
    if (
      overflowY === 'auto' ||
      overflowY === 'scroll' ||
      overflowY === 'overlay'
    ) {
      return current
    }
    current = current.parentElement
  }
  return null
}

/**
 * Bring an element into view by adjusting only the vertical scroll position of
 * its scroll parent. Unlike `Element.scrollIntoView`, this never scrolls any
 * ancestor horizontally (which would shift the whole list sideways).
 */
function scrollIntoViewVertical(element: HTMLElement): void {
  const container = getScrollParent(element)
  if (!container) {
    return
  }
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  if (elementRect.top < containerRect.top) {
    container.scrollTop -= containerRect.top - elementRect.top
  } else if (elementRect.bottom > containerRect.bottom) {
    container.scrollTop += elementRect.bottom - containerRect.bottom
  }
}

/** Case-insensitive AND match: every whitespace-separated token must appear. */
function matches(text: string, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return true
  }
  const haystack = text.toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/**
 * Headless keyboard-navigable filtering for a list of items. Powers both the
 * worktree list and the base-branch combobox: it filters by a query, tracks an
 * active item, and exposes handlers that let the keyboard (up/down/enter) and
 * the mouse (hover/click) drive the same selection seamlessly.
 *
 * Hover uses `onMouseMove` (not `onMouseEnter`) so that scrolling an item under
 * a stationary cursor during keyboard navigation does not hijack the active row.
 */
export function useSearchableList<T>({
  items,
  getText,
  query,
  onSelect,
}: UseSearchableListOptions<T>): UseSearchableListResult<T> {
  const filtered = useMemo(
    () => items.filter((item) => matches(getText(item), query)),
    [items, getText, query],
  )

  const [activeIndex, setActiveIndex] = useState(0)
  const [lastQuery, setLastQuery] = useState(query)
  const elements = useRef(new Map<number, HTMLElement>())

  // Snap back to the first (most relevant) match whenever the query changes so
  // Enter selects what the user is looking at. Adjusting state during render is
  // React's recommended alternative to a query-watching effect.
  if (query !== lastQuery) {
    setLastQuery(query)
    setActiveIndex(0)
  }

  const clampedActive =
    filtered.length === 0 ? -1 : Math.min(activeIndex, filtered.length - 1)

  const scrollIntoView = useCallback((index: number) => {
    const element = elements.current.get(index)
    if (element) {
      scrollIntoViewVertical(element)
    }
  }, [])

  const move = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        if (filtered.length === 0) {
          return current
        }
        const base = Math.min(current, filtered.length - 1)
        const next = Math.min(Math.max(base + delta, 0), filtered.length - 1)
        scrollIntoView(next)
        return next
      })
    },
    [filtered.length, scrollIntoView],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          move(1)
          break
        case 'ArrowUp':
          event.preventDefault()
          move(-1)
          break
        case 'Home':
          event.preventDefault()
          setActiveIndex(0)
          scrollIntoView(0)
          break
        case 'End':
          event.preventDefault()
          setActiveIndex(filtered.length - 1)
          scrollIntoView(filtered.length - 1)
          break
        case 'Enter': {
          const item = filtered[clampedActive]
          if (item !== undefined) {
            event.preventDefault()
            onSelect?.(item, clampedActive)
          }
          break
        }
      }
    },
    [clampedActive, filtered, move, onSelect, scrollIntoView],
  )

  const getItemProps = useCallback(
    (index: number): SearchableItemProps => ({
      role: 'option',
      'aria-selected': index === clampedActive,
      'data-active': index === clampedActive,
      ref: (node: HTMLElement | null) => {
        if (node) {
          elements.current.set(index, node)
        } else {
          elements.current.delete(index)
        }
      },
      onMouseMove: () => {
        if (index !== clampedActive) {
          setActiveIndex(index)
        }
      },
      onClick: () => {
        const item = filtered[index]
        if (item !== undefined) {
          onSelect?.(item, index)
        }
      },
    }),
    [clampedActive, filtered, onSelect],
  )

  return {
    filtered,
    activeIndex: clampedActive,
    setActiveIndex,
    onKeyDown,
    getItemProps,
  }
}
