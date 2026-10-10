import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_DISPLAY_NAME } from '../../../shared/constants'
import type { ConnectionState, Worktree } from '../../../shared/api'
import './style.css'

function App(): React.JSX.Element {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting')
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.desktop.setOnConnectionStateChangedListener(setConnectionState)
    window.desktop.setOnWorktreesChangedListener((worktrees) => {
      setWorktrees(worktrees)
      setError(null)
    })
    window.desktop.initialize()
    return () => {
      window.desktop.setOnConnectionStateChangedListener(undefined)
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
            <li key={worktree.path} title={worktree.path}>
              <span className="worktree-name">{worktree.basename}</span>
              <span className="worktree-branch">
                {worktree.branchName ?? 'Detached HEAD'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
