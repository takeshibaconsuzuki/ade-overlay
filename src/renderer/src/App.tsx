import { Button, Notice, Spinner, Tooltip, UIProvider } from './components/ui'
import { CreateWorktree, DeleteWorktree } from './components/worktree-actions'
import { useCompanion } from './use-companion'
import { useWorktreeNavigation } from './use-worktree-navigation'

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
}

export default function App() {
  const {
    status,
    snapshot,
    loading,
    error,
    refresh,
    reconnect,
    opening,
    openEditor,
  } = useCompanion()
  const connected = status?.state === 'connected'
  const navigation = useWorktreeNavigation()
  return (
    <UIProvider>
      <main
        className="workspace"
        aria-label="Worktrees"
        {...navigation.workspaceProps}
      >
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
          {...navigation.listProps}
          className="worktree-list"
          aria-label="Worktrees"
          aria-busy={loading}
        >
          {snapshot?.worktrees.map((worktree) => {
            const key = JSON.stringify([worktree.project, worktree.path])
            const isOpening = opening === worktree.path
            const starting = isOpening || worktree.editor === 'starting'
            return (
              <li
                key={key}
                data-highlighted={
                  (connected &&
                    !worktree.prunable &&
                    navigation.highlight.key === key) ||
                  undefined
                }
              >
                <Tooltip
                  content={
                    starting
                      ? (worktree.editorDetail ?? 'Opening VS Code')
                      : undefined
                  }
                >
                  <Button
                    tone="secondary"
                    className="worktree-open"
                    data-worktree-key={key}
                    disabled={!connected || worktree.prunable}
                    aria-busy={starting}
                    aria-disabled={isOpening || !connected || worktree.prunable}
                    onClick={() => {
                      if (!isOpening) void openEditor(worktree)
                    }}
                  >
                    <span
                      className="editor-status"
                      role="img"
                      aria-label={
                        starting
                          ? 'Editor opening'
                          : `Editor ${worktree.editor}`
                      }
                    >
                      {starting ? (
                        <Spinner />
                      ) : (
                        <span
                          className={`editor-dot ${worktree.editor === 'running' ? 'running' : ''}`}
                        />
                      )}
                    </span>
                    <span className="worktree-name">
                      <span>{basename(worktree.path)}</span>
                      <span className="worktree-branch">
                        {worktree.branch ?? 'Detached HEAD'}
                      </span>
                    </span>
                  </Button>
                </Tooltip>
                <div className="worktree-delete">
                  <DeleteWorktree worktree={worktree} connected={connected} />
                </div>
              </li>
            )
          })}
        </ul>
      </main>
    </UIProvider>
  )
}
