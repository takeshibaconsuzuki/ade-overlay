import React, { useEffect, useId, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_DISPLAY_NAME } from '../../../shared/constants'
import type {
  ConnectionState,
  Worktree,
  VscodeServerStatus,
} from '../../../shared/api'
import '../../shared/style.css'
import './style.css'

function WorktreeRow({
  worktree,
  status,
}: {
  worktree: Worktree
  status?: VscodeServerStatus
}): React.JSX.Element {
  const [requestError, setRequestError] = useState<string | null>(null)
  const tooltipId = useId()
  const state = status?.state ?? 'stopped'
  const message = requestError ?? status?.error?.message
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
    if (!status?.error) return
    try {
      await window.picker.clearVscodeServerError(worktree.path, status.error.id)
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : 'Unable to dismiss error',
      )
    }
  }
  return (
    <li className="worktree-row">
      <button
        className="worktree-open"
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
          className={`server-status server-status-${state}`}
          role="status"
          aria-label={`VS Code Server ${state}`}
          title={`VS Code Server ${state}`}
        />
      )}
    </li>
  )
}

function WorktreePicker(): React.JSX.Element {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting')
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [vscodeServers, setVscodeServers] = useState<VscodeServerStatus[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.picker.setOnConnectionStateChangedListener(setConnectionState)
    window.picker.setOnVscodeServersChangedListener(setVscodeServers)
    window.picker.setOnWorktreesChangedListener((worktrees) => {
      setWorktrees(worktrees)
      setError(null)
    })
    window.picker.initializeWorktreePicker()
    return () => {
      window.picker.setOnConnectionStateChangedListener(undefined)
      window.picker.setOnVscodeServersChangedListener(undefined)
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
            <WorktreeRow
              key={worktree.path}
              worktree={worktree}
              status={vscodeServers.find(
                (status) => status.path === worktree.path,
              )}
            />
          ))}
        </ul>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<WorktreePicker />)
