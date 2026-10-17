import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import {
  DotsHorizontalIcon,
  ExclamationTriangleIcon,
  ReloadIcon,
  MagnifyingGlassIcon,
} from '@radix-ui/react-icons'
import {
  Button,
  DropdownMenu,
  Flex,
  IconButton,
  ScrollArea,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from '@radix-ui/themes'
import type { ConnectionState, Worktree } from '../../../shared/api'
import { AppTheme } from '../../../ui/AppTheme'
import { ErrorMessage } from '../../../ui/Feedback'
import './style.css'

function worktreeRowId(path: string): string {
  return `worktree-${encodeURIComponent(path)}`
}

function WorktreeRow({
  worktree,
  highlighted,
  onHighlight,
  menuOpen,
  onMenuOpenChange,
  onCloseAutoFocus,
}: {
  worktree: Worktree
  highlighted: boolean
  onHighlight: () => void
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onCloseAutoFocus: (event: Event) => void
}): React.JSX.Element {
  const status = worktree.vscode
  const [pending, setPending] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const state = status.state
  const error = worktree.error
  const message = requestError ?? error?.message
  const unavailable = pending || worktree.deleting || state === 'stopping'
  const busy = worktree.deleting || state === 'starting' || state === 'stopping'
  const statusLabel = worktree.deleting
    ? 'Deleting worktree'
    : `VS Code Server ${state}`
  const start = async () => {
    setRequestError(null)
    try {
      await window.picker.openWorktree(worktree.path)
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? error.message
          : 'Unable to start VS Code Server',
      )
    }
  }
  const clear = async () => {
    setRequestError(null)
    if (!error) return
    try {
      await window.picker.clearWorktreeError(worktree.path, error.id)
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : 'Unable to dismiss error',
      )
    }
  }
  const perform = async (operation: () => Promise<void>) => {
    setPending(true)
    setRequestError(null)
    try {
      await operation()
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : 'Worktree operation failed',
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <li
      id={worktreeRowId(worktree.path)}
      role="row"
      className="worktree-row"
      data-path={worktree.path}
      data-highlighted={highlighted}
      aria-selected={highlighted}
      aria-label={`${worktree.basename}, ${worktree.branchName ?? 'Detached HEAD'}`}
      onFocus={onHighlight}
    >
      <Flex role="gridcell" align="center" gap="3" px="3" py="3">
        <Tooltip
          content={message ?? statusLabel}
          className="worktree-status-tooltip"
        >
          <Text
            asChild
            color={
              message
                ? 'red'
                : state === 'running' && !worktree.deleting
                  ? 'green'
                  : 'gray'
            }
          >
            <span
              className="worktree-status"
              role="status"
              aria-label={
                message ? `Error for ${worktree.basename}` : statusLabel
              }
              aria-busy={!message && busy}
              tabIndex={message ? 0 : undefined}
            >
              {message ? (
                <ExclamationTriangleIcon
                  width="16"
                  height="16"
                  aria-hidden="true"
                />
              ) : busy ? (
                <Spinner size="1" aria-hidden="true" />
              ) : (
                <span className="worktree-dot" aria-hidden="true" />
              )}
            </span>
          </Text>
        </Tooltip>
        <Button
          className="worktree-open"
          variant="ghost"
          color="gray"
          disabled={unavailable}
          type="button"
          title={worktree.path}
          onClick={() => void start()}
        >
          <Flex asChild direction="column" align="start" gap="1">
            <span>
              <Text size="3" weight="medium">
                {worktree.basename}
              </Text>
              <Text size="2" color="gray">
                {worktree.branchName ?? 'Detached HEAD'}
              </Text>
            </span>
          </Flex>
        </Button>
        <Flex className="worktree-actions" align="center">
          <DropdownMenu.Root open={menuOpen} onOpenChange={onMenuOpenChange}>
            <DropdownMenu.Trigger>
              <IconButton
                variant="ghost"
                color="gray"
                type="button"
                aria-label={`Actions for ${worktree.basename}`}
              >
                <DotsHorizontalIcon />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content
              align="end"
              onCloseAutoFocus={onCloseAutoFocus}
            >
              <DropdownMenu.Item
                // Only a worktree error enables another Stop request while stopping.
                disabled={
                  pending ||
                  worktree.deleting ||
                  state === 'stopped' ||
                  (state === 'stopping' && !error)
                }
                onSelect={() =>
                  void perform(() =>
                    window.picker.stopVscodeServer(worktree.path),
                  )
                }
              >
                Stop
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={!message}
                onSelect={() => void clear()}
              >
                Dismiss error
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                color="red"
                disabled={
                  unavailable || worktree.path === worktree.mainWorktreePath
                }
                onSelect={() =>
                  void perform(() =>
                    window.picker.deleteWorktree(worktree.path),
                  )
                }
              >
                Delete worktree
              </DropdownMenu.Item>
              <DropdownMenu.Item
                color="red"
                disabled={
                  unavailable ||
                  worktree.path === worktree.mainWorktreePath ||
                  !worktree.branchName
                }
                onSelect={() =>
                  void perform(() =>
                    window.picker.deleteWorktree(
                      worktree.path,
                      worktree.branchName!,
                    ),
                  )
                }
              >
                Delete worktree and branch
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Flex>
      </Flex>
    </li>
  )
}

function WorktreePicker(): React.JSX.Element {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting')
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [menu, setMenu] = useState<{
    path: string | null
    closedByReset: boolean
  }>({ path: null, closedByReset: false })
  const pickerVisible = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const pointerPosition = useRef<{ x: number; y: number } | null>(null)
  const scrollToSelection = useRef(true)
  const search = query.trim().toLowerCase()
  const filteredWorktrees = worktrees.filter((worktree) =>
    [worktree.basename, worktree.branchName ?? 'Detached HEAD'].some((value) =>
      value.toLowerCase().includes(search),
    ),
  )
  // An open menu cannot outlive the row that owns its trigger.
  if (
    menu.path !== null &&
    (connectionState !== 'connected' ||
      !filteredWorktrees.some((worktree) => worktree.path === menu.path))
  ) {
    setMenu({ path: null, closedByReset: true })
  }
  // Derive a valid selection in the same render as filtering or server updates.
  const selectedIndex = Math.max(
    0,
    filteredWorktrees.findIndex((worktree) => worktree.path === selectedPath),
  )
  const highlightedPath = filteredWorktrees[selectedIndex]?.path
  const hasResults =
    connectionState === 'connected' && filteredWorktrees.length > 0

  useLayoutEffect(() => {
    if (scrollToSelection.current) {
      listRef.current
        ?.querySelector('[data-highlighted="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightedPath, query])

  useEffect(() => {
    window.picker.setOnVisibilityChangedListener((visible) => {
      pickerVisible.current = visible
      // Each picker session starts with an empty search and the first row at the top.
      // Release menu focus synchronously so it cannot block search focus.
      flushSync(() => {
        setMenu({ path: null, closedByReset: true })
        setQuery('')
        setSelectedPath(null)
        scrollToSelection.current = true
      })
      pointerPosition.current = null
      if (resultsRef.current) resultsRef.current.scrollTop = 0
      if (visible) searchRef.current?.focus({ preventScroll: true })
    })
    window.picker.setOnConnectionStateChangedListener(setConnectionState)
    window.picker.setOnWorktreesChangedListener((worktrees) => {
      setWorktrees(worktrees)
      setSelectedPath((path) =>
        worktrees.some((worktree) => worktree.path === path) ? path : null,
      )
      setError(null)
    })
    window.picker.initializeWorktreePicker()
    return () => {
      window.picker.setOnConnectionStateChangedListener(undefined)
      window.picker.setOnWorktreesChangedListener(undefined)
      window.picker.setOnVisibilityChangedListener(undefined)
    }
  }, [])

  const navigate = (event: React.KeyboardEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.target as HTMLElement).closest('[role="menu"]')
    )
      return
    if (event.key === 'Escape' && event.target === searchRef.current) {
      event.preventDefault()
      window.picker.hideWorktreePicker()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!filteredWorktrees.length) return
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const index =
        (selectedIndex + direction + filteredWorktrees.length) %
        filteredWorktrees.length
      scrollToSelection.current = true
      setSelectedPath(filteredWorktrees[index].path)
      searchRef.current?.focus({ preventScroll: true })
      listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' })
    } else if (
      event.key === 'Enter' &&
      (event.target === searchRef.current ||
        (event.target as HTMLElement).closest('.worktree-open'))
    ) {
      event.preventDefault()
      listRef.current
        ?.querySelector<HTMLButtonElement>(
          '[data-highlighted="true"] .worktree-open',
        )
        ?.click()
    }
  }

  // A pointer that left the picker must move within it again before it selects a row.
  const forgetPointer = () => {
    pointerPosition.current = null
  }

  const highlightUnderPointer = (event: React.PointerEvent<HTMLElement>) => {
    const previous = pointerPosition.current
    pointerPosition.current = { x: event.clientX, y: event.clientY }
    // Only movement observed within the session selects a row. The first event of a session
    // merely records the pointer: showing the picker beneath it dispatches a move without the
    // mouse moving, as does scrolling a keyboard selection under a stationary pointer.
    if (
      !previous ||
      (previous.x === event.clientX && previous.y === event.clientY)
    )
      return
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      '.worktree-row',
    )
    if (row?.dataset.path) {
      scrollToSelection.current = false
      setSelectedPath(row.dataset.path)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      await window.picker.refreshWorktrees()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to refresh worktrees',
      )
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <main
      className="worktree-picker"
      onKeyDown={navigate}
      onPointerMove={highlightUnderPointer}
      onPointerLeave={forgetPointer}
    >
      <Flex asChild align="center" gap="3">
        <header className="picker-toolbar">
          <TextField.Root
            ref={searchRef}
            className="worktree-search"
            type="search"
            role="combobox"
            aria-label="Search worktrees"
            aria-autocomplete="list"
            aria-haspopup="grid"
            aria-expanded={hasResults}
            aria-controls={hasResults ? 'worktree-list' : undefined}
            aria-activedescendant={
              hasResults ? worktreeRowId(highlightedPath!) : undefined
            }
            placeholder="Search worktrees…"
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedPath(null)
              scrollToSelection.current = true
            }}
          >
            <TextField.Slot>
              <MagnifyingGlassIcon />
            </TextField.Slot>
          </TextField.Root>
          <Button
            type="button"
            variant="soft"
            onClick={() => void refresh()}
            disabled={refreshing || connectionState !== 'connected'}
            aria-busy={refreshing}
          >
            <Spinner loading={refreshing} aria-hidden="true">
              <ReloadIcon />
            </Spinner>
            Refresh
          </Button>
        </header>
      </Flex>
      <ScrollArea
        ref={resultsRef}
        className="picker-results"
        type="auto"
        scrollbars="vertical"
        size="2"
      >
        <Flex direction="column" gap="4">
          {error && <ErrorMessage>{error}</ErrorMessage>}
          {connectionState !== 'connected' ? (
            <Flex align="center" justify="center" gap="3" py="6" role="status">
              <Spinner aria-hidden="true" />
              <Text size="2" color="gray">
                Connecting to server
              </Text>
            </Flex>
          ) : filteredWorktrees.length === 0 ? (
            <Text as="p" size="2" color="gray">
              {worktrees.length === 0
                ? 'No worktrees found.'
                : 'No matching worktrees.'}
            </Text>
          ) : (
            <Flex asChild direction="column">
              <ul
                className="worktrees"
                id="worktree-list"
                role="grid"
                ref={listRef}
                aria-label="Worktrees"
                aria-busy={refreshing}
              >
                {filteredWorktrees.map((worktree) => (
                  <WorktreeRow
                    key={worktree.path}
                    worktree={worktree}
                    highlighted={worktree.path === highlightedPath}
                    onHighlight={() => setSelectedPath(worktree.path)}
                    menuOpen={menu.path === worktree.path}
                    onMenuOpenChange={(open) =>
                      setMenu({
                        path: open ? worktree.path : null,
                        closedByReset: false,
                      })
                    }
                    onCloseAutoFocus={(event) => {
                      // Session resets return focus to search after the menu releases it.
                      if (menu.closedByReset) {
                        event.preventDefault()
                        if (pickerVisible.current)
                          searchRef.current?.focus({ preventScroll: true })
                      }
                    }}
                  />
                ))}
              </ul>
            </Flex>
          )}
        </Flex>
      </ScrollArea>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <AppTheme>
    <WorktreePicker />
  </AppTheme>,
)
