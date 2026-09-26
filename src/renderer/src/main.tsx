import { createRoot } from 'react-dom/client'
import { Button, Notice, UIProvider } from './components/ui'
import { CreateWorktree, DeleteWorktree } from './components/worktree-actions'
import { useCompanion } from './use-companion'
import './style.css'

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
}

function App() {
  const { status, snapshot, loading, error, refresh, reconnect } =
    useCompanion()
  const connected = status?.state === 'connected'
  return (
    <UIProvider>
      <main className="workspace" aria-label="Worktrees">
        <div className="toolbar">
          <Button tone="secondary" onClick={() => void reconnect()}>
            Reconnect
          </Button>
          <Button
            tone="secondary"
            busy={loading && connected}
            disabled={!connected}
            onClick={() => void refresh()}
          >
            Refresh worktrees
          </Button>
          <CreateWorktree snapshot={snapshot} connected={connected} />
        </div>
        {(error || status?.error) && <Notice>{error || status?.error}</Notice>}
        <ul
          className="worktree-list"
          aria-label="Worktrees"
          aria-busy={loading}
        >
          {snapshot?.worktrees.map((worktree) => (
            <li key={`${worktree.project}\0${worktree.path}`}>
              <span>{basename(worktree.path)}</span>
              <span className="worktree-branch">
                {worktree.branch ?? 'Detached HEAD'}
              </span>
              <DeleteWorktree worktree={worktree} connected={connected} />
            </li>
          ))}
        </ul>
      </main>
    </UIProvider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
