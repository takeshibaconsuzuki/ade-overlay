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
  AlertDialog,
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
import { StartCommandTerminal } from './start-command-terminal'
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
  deletionOpen,
  onDeletionOpenChange,
  onDeletionCloseAutoFocus,
}: {
  worktree: Worktree
  highlighted: boolean
  onHighlight: () => void
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onCloseAutoFocus: (event: Event) => void
  deletionOpen: boolean
  onDeletionOpenChange: (open: boolean) => void
  onDeletionCloseAutoFocus: (event: Event) => void
}): React.JSX.Element {
  const status = worktree.vscode
  const [pending, setPending] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  // Retained after the confirmation closes, so its content stays put while it animates out.
  // Changes and their read error are absent while the confirmation is still reading them.
  const [deletion, setDeletion] = useState<{
    branchName?: string
    changes?: string[]
    error?: string
  }>({})
  const force = !!deletion.changes?.length
  const deleteAction = `${force ? 'Force delete' : 'Delete'} worktree${deletion.branchName === undefined ? '' : ' and branch'}`
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
  // The confirmation opens at once and reads the changes itself, so nothing can intervene
  // between the request and the prompt. A newer request supersedes an older one's result.
  const confirmDeletion = (branchName?: string) => {
    const request = { branchName }
    setDeletion(request)
    onDeletionOpenChange(true)
    const settle = (result: { changes: string[] } | { error: string }) =>
      setDeletion((current) =>
        current === request ? { ...request, ...result } : current,
      )
    window.picker.getWorktreeChanges(worktree.path).then(
      (changes) => settle({ changes }),
      (error: unknown) =>
        settle({
          error:
            error instanceof Error
              ? error.message
              : 'Unable to read uncommitted changes',
        }),
    )
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
                onSelect={() => confirmDeletion()}
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
                onSelect={() => confirmDeletion(worktree.branchName!)}
              >
                Delete worktree and branch
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          <AlertDialog.Root
            open={deletionOpen}
            onOpenChange={onDeletionOpenChange}
          >
            <AlertDialog.Content
              maxWidth="600px"
              onCloseAutoFocus={onDeletionCloseAutoFocus}
            >
              <AlertDialog.Title>
                {force ? 'Force delete' : 'Delete'} worktree {worktree.basename}
                {deletion.branchName !== undefined &&
                  ` and branch ${deletion.branchName}`}
                ?
              </AlertDialog.Title>
              <Flex direction="column" gap="3">
                <AlertDialog.Description size="2">
                  {force
                    ? 'Its VS Code server will stop and its directory will be removed, discarding the uncommitted changes below.'
                    : 'Its VS Code server will stop and its directory will be removed. Worktrees with uncommitted changes will not be deleted.'}
                  {deletion.branchName !== undefined &&
                    ' Its local branch will then be deleted, including any unmerged commits. If branch deletion fails, the worktree will still be removed and the error will appear on the main worktree.'}
                </AlertDialog.Description>
                {deletion.error !== undefined ? (
                  <ErrorMessage>{deletion.error}</ErrorMessage>
                ) : deletion.changes === undefined ? (
                  <Flex align="center" gap="2" role="status">
                    <Spinner aria-hidden="true" />
                    <Text size="2" color="gray">
                      Checking for uncommitted changes…
                    </Text>
                  </Flex>
                ) : (
                  force && (
                    <ScrollArea
                      className="worktree-changes"
                      type="auto"
                      scrollbars="vertical"
                    >
                      <pre>{deletion.changes.join('\n')}</pre>
                    </ScrollArea>
                  )
                )}
              </Flex>
              <Flex gap="3" mt="4" justify="end">
                <AlertDialog.Cancel>
                  <Button variant="soft" color="gray">
                    Cancel
                  </Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action>
                  <Button
                    color="red"
                    disabled={unavailable || deletion.changes === undefined}
                    onClick={() =>
                      void perform(() =>
                        window.picker.deleteWorktree(
                          worktree.path,
                          deletion.branchName,
                          force,
                        ),
                      )
                    }
                  >
                    {deleteAction}
                  </Button>
                </AlertDialog.Action>
              </Flex>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </Flex>
      </Flex>
    </li>
  )
}

function WorktreePicker(): React.JSX.Element {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting')
  const [startCommandEnabled, setStartCommandEnabled] = useState<
    boolean | null
  >(null)
  const [visible, setVisible] = useState(false)
  const showTerminal =
    startCommandEnabled === true && connectionState !== 'connected'
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [menu, setMenu] = useState<{
    path: string | null
    closedByReset: boolean
  }>({ path: null, closedByReset: false })
  const [deletionPath, setDeletionPath] = useState<string | null>(null)
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
  // An open menu or deletion confirmation cannot outlive the row that owns it.
  const rowShown = (path: string) =>
    connectionState === 'connected' &&
    filteredWorktrees.some((worktree) => worktree.path === path)
  if (menu.path !== null && !rowShown(menu.path)) {
    setMenu({ path: null, closedByReset: true })
  }
  if (deletionPath !== null && !rowShown(deletionPath)) {
    setDeletionPath(null)
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
    if (visible && !showTerminal)
      searchRef.current?.focus({ preventScroll: true })
  }, [visible, showTerminal])

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
        setVisible(visible)
        setMenu({ path: null, closedByReset: true })
        setDeletionPath(null)
        setQuery('')
        setSelectedPath(null)
        scrollToSelection.current = true
      })
      pointerPosition.current = null
      if (resultsRef.current) resultsRef.current.scrollTop = 0
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
      showTerminal ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.target as HTMLElement).closest(
        '[role="menu"], [role="alertdialog"]',
      )
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
      <StartCommandTerminal
        active={showTerminal}
        visible={visible}
        onInitialized={setStartCommandEnabled}
      />
      {!showTerminal && (
        <>
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
                startCommandEnabled === false && (
                  <Flex
                    align="center"
                    justify="center"
                    gap="3"
                    py="6"
                    role="status"
                  >
                    <Spinner aria-hidden="true" />
                    <Text size="2" color="gray">
                      Connecting to server
                    </Text>
                  </Flex>
                )
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
                        deletionOpen={deletionPath === worktree.path}
                        onDeletionOpenChange={(open) =>
                          setDeletionPath(open ? worktree.path : null)
                        }
                        onDeletionCloseAutoFocus={(event) => {
                          // The confirmation has no trigger to return focus to.
                          event.preventDefault()
                          if (pickerVisible.current)
                            searchRef.current?.focus({ preventScroll: true })
                        }}
                      />
                    ))}
                  </ul>
                </Flex>
              )}
            </Flex>
          </ScrollArea>
        </>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <AppTheme>
    <WorktreePicker />
  </AppTheme>,
)
