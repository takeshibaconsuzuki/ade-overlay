import { useState } from 'react'
import {
  Button,
  Notice,
  SearchField,
  ScrollBox,
  Spinner,
  Tooltip,
  UIProvider,
} from './components/ui'
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
    rowErrors,
    clearError,
  } = useCompanion()
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const worktrees =
    snapshot?.worktrees.filter(
      (worktree) =>
        basename(worktree.path).toLowerCase().includes(query) ||
        (worktree.branch ?? '').toLowerCase().includes(query),
    ) ?? []
  // Editor progress updates should not reset the user's place in the results.
  const resultsKey = JSON.stringify([
    query,
    worktrees.map(({ project, path, branch, prunable }) => [
      project,
      path,
      branch,
      prunable,
    ]),
  ])
  const connected = status?.state === 'connected'
  const availabilityKey = JSON.stringify([
    connected,
    worktrees.map(({ operation, missing }) => [!!operation, !!missing]),
  ])
  const {
    searchRef,
    scrollRef,
    highlight,
    tooltipDismissVersion,
    workspaceProps,
    listProps,
  } = useWorktreeNavigation(resultsKey, search, availabilityKey)
  return (
    <UIProvider>
      <main className="workspace" aria-label="Worktrees" {...workspaceProps}>
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
        <SearchField
          ref={searchRef}
          className="worktree-search"
          aria-label="Search worktrees by basename or branch"
          aria-controls="worktree-results"
          placeholder="Search worktrees by basename or branch"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
        />
        {query && !worktrees.length && (
          <p role="status">No matching worktrees.</p>
        )}
        <ScrollBox ref={scrollRef} className="worktree-scrollbox">
          <ul
            id="worktree-results"
            {...listProps}
            className="worktree-list"
            aria-label="Worktrees"
            aria-busy={loading}
          >
            {worktrees.map((worktree) => {
              const key = JSON.stringify([worktree.project, worktree.path])
              const isOpening = opening === worktree.path
              const rowError = rowErrors[key] || worktree.error
              const starting =
                !!worktree.operation ||
                isOpening ||
                worktree.editor === 'starting'
              const showError = !!rowError && !starting
              const unavailable =
                !connected ||
                worktree.prunable ||
                !!worktree.operation ||
                worktree.missing
              const detail =
                worktree.operation === 'creating'
                  ? 'Creating worktree'
                  : worktree.operation === 'deleting'
                    ? 'Deleting worktree'
                    : (worktree.editorDetail ?? 'Opening VS Code')
              return (
                <li
                  key={key}
                  data-highlighted={
                    (connected && !unavailable && highlight.key === key) ||
                    undefined
                  }
                >
                  <Tooltip
                    content={starting ? detail : rowError || undefined}
                    dismissVersion={tooltipDismissVersion}
                    keepOpenOnClick={isOpening || unavailable}
                  >
                    <div className="worktree-entry">
                      {showError && (
                        <Button
                          tone="danger"
                          className="worktree-error"
                          aria-label={`Clear error for ${basename(worktree.path)}: ${rowError}`}
                          onClick={() => void clearError(worktree)}
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path
                              d="M3 3 13 13M13 3 3 13"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                            />
                          </svg>
                        </Button>
                      )}
                      <Button
                        tone="secondary"
                        className="worktree-open"
                        data-worktree-key={key}
                        disabled={unavailable}
                        aria-busy={starting}
                        aria-disabled={isOpening || unavailable}
                        onClick={() => {
                          if (!isOpening) void openEditor(worktree)
                        }}
                      >
                        <span
                          className={`editor-status ${showError ? 'has-error' : ''}`}
                          role="img"
                          aria-label={
                            starting
                              ? detail
                              : showError
                                ? 'Worktree error'
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
                    </div>
                  </Tooltip>
                  <div className="worktree-delete">
                    <DeleteWorktree worktree={worktree} connected={connected} />
                  </div>
                </li>
              )
            })}
          </ul>
        </ScrollBox>
      </main>
    </UIProvider>
  )
}
