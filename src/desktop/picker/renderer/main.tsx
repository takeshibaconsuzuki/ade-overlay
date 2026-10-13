import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DotsHorizontalIcon,
  ExclamationTriangleIcon,
  ReloadIcon,
} from '@radix-ui/react-icons'
import {
  Box,
  Button,
  DropdownMenu,
  Flex,
  Heading,
  IconButton,
  Spinner,
  Text,
  Tooltip,
} from '@radix-ui/themes'
import { APP_DISPLAY_NAME } from '../../../shared/constants'
import type { ConnectionState, Worktree } from '../../../shared/api'
import { AppTheme } from '../../../ui/AppTheme'
import { ErrorMessage, LoadingScreen } from '../../../ui/Feedback'
import './style.css'

function WorktreeRow({ worktree }: { worktree: Worktree }): React.JSX.Element {
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
    <Flex asChild align="center" gap="3" px="3" py="3">
      <li className="worktree-row">
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
          <DropdownMenu.Root>
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
            <DropdownMenu.Content align="end">
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
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Flex>
      </li>
    </Flex>
  )
}

function WorktreePicker(): React.JSX.Element {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting')
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.picker.setOnConnectionStateChangedListener(setConnectionState)
    window.picker.setOnWorktreesChangedListener((worktrees) => {
      setWorktrees(worktrees)
      setError(null)
    })
    window.picker.initializeWorktreePicker()
    return () => {
      window.picker.setOnConnectionStateChangedListener(undefined)
      window.picker.setOnWorktreesChangedListener(undefined)
    }
  }, [])

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

  if (connectionState !== 'connected') {
    return <LoadingScreen label="Connecting to server" />
  }

  return (
    <main className="worktree-picker">
      <Flex asChild align="center" justify="between" gap="4" mb="6">
        <header>
          <Box>
            <Text as="p" size="2" color="gray" mb="1">
              {APP_DISPLAY_NAME}
            </Text>
            <Heading as="h1" size="7">
              Worktrees
            </Heading>
          </Box>
          <Button
            type="button"
            variant="soft"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            {refreshing ? <Spinner aria-hidden="true" /> : <ReloadIcon />}
            Refresh
          </Button>
        </header>
      </Flex>
      <Flex direction="column" gap="4">
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {worktrees.length === 0 ? (
          <Text as="p" size="2" color="gray">
            No worktrees found.
          </Text>
        ) : (
          <Flex asChild direction="column">
            <ul
              className="worktrees"
              aria-label="Worktrees"
              aria-busy={refreshing}
            >
              {worktrees.map((worktree) => (
                <WorktreeRow key={worktree.path} worktree={worktree} />
              ))}
            </ul>
          </Flex>
        )}
      </Flex>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <AppTheme>
    <WorktreePicker />
  </AppTheme>,
)
