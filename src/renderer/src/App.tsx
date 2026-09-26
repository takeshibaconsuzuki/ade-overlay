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
  const {
    searchRef,
    scrollRef,
    onSearchFocus,
    highlight,
    workspaceProps,
    listProps,
  } = useWorktreeNavigation(resultsKey)
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
          onFocus={onSearchFocus}
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
              const starting = isOpening || worktree.editor === 'starting'
              return (
                <li
                  key={key}
                  data-highlighted={
                    (connected &&
                      !worktree.prunable &&
                      highlight.key === key) ||
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
                      aria-disabled={
                        isOpening || !connected || worktree.prunable
                      }
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
        </ScrollBox>
      </main>
    </UIProvider>
  )
}
