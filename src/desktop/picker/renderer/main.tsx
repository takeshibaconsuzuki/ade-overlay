import React, { useEffect, useId, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_DISPLAY_NAME } from '../../../shared/constants'
import type { ConnectionState, Worktree } from '../../../shared/api'
import '../../shared/style.css'
import './style.css'

function WorktreeRow({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const status = worktree.vscode
  const [pending, setPending] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const tooltipId = useId()
  const state = status.state
  const error = worktree.error
  const message = requestError ?? error?.message
  const unavailable = pending || worktree.deleting || state === 'stopping'
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
    <li className="worktree-row">
      <button
        className="worktree-open"
        disabled={unavailable}
        type="button"
        title={worktree.path}
        onClick={() => void start()}
      >
        <span className="worktree-name">{worktree.basename}</span>
        <span className="worktree-branch">
          {worktree.branchName ?? 'Detached HEAD'}
        </span>
      </button>
      {message ? (
        <span className="worktree-error">
          <button
            className="status-error"
            type="button"
            aria-label={`Dismiss error for ${worktree.basename}`}
            aria-describedby={tooltipId}
            onClick={() => void clear()}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="8" />
              <path d="M10 5v6m0 3v1" />
            </svg>
          </button>
          <span className="error-tooltip" id={tooltipId} role="tooltip">
            {message}
          </span>
        </span>
      ) : (
        <span
          className={`server-status server-status-${worktree.deleting ? 'deleting' : state}`}
          aria-busy={
            worktree.deleting || state === 'starting' || state === 'stopping'
          }
          role="status"
          aria-label={
            worktree.deleting ? 'Deleting worktree' : `VS Code Server ${state}`
          }
          title={
            worktree.deleting ? 'Deleting worktree' : `VS Code Server ${state}`
          }
        />
      )}
      <div className="worktree-actions">
        <button
          type="button"
          // Only a worktree error enables another Stop request while stopping.
          disabled={
            pending ||
            worktree.deleting ||
            state === 'stopped' ||
            (state === 'stopping' && !error)
          }
          onClick={() =>
            void perform(() => window.picker.stopVscodeServer(worktree.path))
          }
        >
          Stop
        </button>
        {worktree.path !== worktree.mainWorktreePath && (
          <button
            type="button"
            disabled={unavailable}
            onClick={() =>
              void perform(() => window.picker.deleteWorktree(worktree.path))
            }
          >
            {worktree.deleting ? 'Deleting...' : 'Delete'}
          </button>
        )}
      </div>
    </li>
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
    return (
      <div
        className="connection-screen"
        role="status"
        aria-label="Connecting to server"
      >
        <span className="connection-spinner" aria-hidden="true" />
      </div>
    )
  }

  return (
    <main>
      <header>
        <div>
          <p className="app-name">{APP_DISPLAY_NAME}</p>
          <h1>Worktrees</h1>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          Refresh
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {worktrees.length === 0 ? (
        <p className="empty">No worktrees found.</p>
      ) : (
        <ul aria-label="Worktrees" aria-busy={refreshing}>
          {worktrees.map((worktree) => (
            <WorktreeRow key={worktree.path} worktree={worktree} />
          ))}
        </ul>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<WorktreePicker />)
