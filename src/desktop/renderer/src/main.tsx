import React, { useEffect, useId, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_DISPLAY_NAME } from '../../../shared/constants'
import type {
  ConnectionState,
  Worktree,
  VscodeServerStatus,
} from '../../../shared/api'
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
      await window.desktop.openWorktree(worktree.path)
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
      await window.desktop.clearVscodeServerError(
        worktree.path,
        status.error.id,
      )
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
    window.desktop.setOnConnectionStateChangedListener(setConnectionState)
    window.desktop.setOnVscodeServersChangedListener(setVscodeServers)
    window.desktop.setOnWorktreesChangedListener((worktrees) => {
      setWorktrees(worktrees)
      setError(null)
    })
    window.desktop.initializeWorktreePicker()
    return () => {
      window.desktop.setOnConnectionStateChangedListener(undefined)
      window.desktop.setOnVscodeServersChangedListener(undefined)
      window.desktop.setOnWorktreesChangedListener(undefined)
    }
  }, [])

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      await window.desktop.refreshWorktrees()
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

function EditorShell(): React.JSX.Element {
  const [state, setState] = useState<import('../../api').EditorState>({
    title: 'VS Code',
  })
  useEffect(() => {
    window.desktop.setOnEditorStateChangedListener(setState)
    window.desktop.initializeEditorWindow()
    return () => window.desktop.setOnEditorStateChangedListener(undefined)
  }, [])
  return state.error ? (
    <main className="editor-error">
      <h1>{state.title}</h1>
      <p role="alert">{state.error}</p>
      <button
        type="button"
        onClick={() => void window.desktop.retryEditor().catch(() => {})}
      >
        Retry
      </button>
    </main>
  ) : (
    <div
      className="connection-screen"
      role="status"
      aria-label={`Loading ${state.title}`}
    >
      <span className="connection-spinner" aria-hidden="true" />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  window.location.hash === '#editor' ? <EditorShell /> : <WorktreePicker />,
)
