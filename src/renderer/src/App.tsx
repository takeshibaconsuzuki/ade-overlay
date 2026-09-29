import { useEffect, useState } from 'react'
import {
  Button,
  Notice,
  Spinner,
  Tooltip,
  UIProvider,
  WorktreeName,
} from '../../shared/ui/components'
import { CreateWorktree, DeleteWorktree } from './components/worktree-actions'
import { useCompanion } from './use-companion'
import { Picker, PickerAction } from '../../shared/ui/picker'

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
  const [recentPicks, setRecentPicks] = useState<string[]>([])
  const [resetVersion, setResetVersion] = useState(0)
  useEffect(
    () =>
      window.pickerWindow.onHidden(() => {
        setSearch('')
        setResetVersion((version) => version + 1)
      }),
    [],
  )
  const query = search.trim().toLowerCase()
  const matches =
    snapshot?.worktrees.filter(
      (worktree) =>
        basename(worktree.path).toLowerCase().includes(query) ||
        (worktree.branch ?? '').toLowerCase().includes(query),
    ) ?? []
  const pickOrder = new Map(recentPicks.map((key, index) => [key, index]))
  const worktrees = [...matches].sort((a, b) => {
    const aOpen = a.editor !== 'stopped'
    const bOpen = b.editor !== 'stopped'
    if (aOpen !== bOpen) return aOpen ? -1 : 1
    if (!aOpen) return 0
    return (
      (pickOrder.get(JSON.stringify([a.project, a.path])) ??
        recentPicks.length) -
      (pickOrder.get(JSON.stringify([b.project, b.path])) ?? recentPicks.length)
    )
  })
  // Reset selection and scroll when results reorder, but not for progress alone.
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
  return (
    <UIProvider>
      <Picker
        className="workspace"
        label="Worktrees"
        items={worktrees}
        itemKey={(worktree) =>
          JSON.stringify([worktree.project, worktree.path])
        }
        available={(worktree) =>
          !(
            !connected ||
            worktree.prunable ||
            worktree.operation ||
            worktree.missing
          )
        }
        resultsKey={resultsKey}
        resetVersion={resetVersion}
        onActivate={(worktree) => {
          if (opening === worktree.path) return
          const key = JSON.stringify([worktree.project, worktree.path])
          setRecentPicks((current) => [
            key,
            ...current.filter((entry) => entry !== key),
          ])
          void openEditor(worktree)
        }}
        search={{
          className: 'worktree-search',
          'aria-label': 'Search worktrees by basename or branch',
          'aria-controls': 'worktree-results',
          placeholder: 'Search worktrees by basename or branch',
          value: search,
          onChange: (event) => setSearch(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void window.pickerWindow.hide()
            }
          },
          autoFocus: true,
        }}
        header={
          <>
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
            {(error || status?.error) && (
              <Notice>{error || status?.error}</Notice>
            )}
          </>
        }
        empty={query ? <p role="status">No matching worktrees.</p> : undefined}
        scrollClassName="worktree-scrollbox"
        listClassName="worktree-list"
        listId="worktree-results"
        busy={loading}
        renderItem={(worktree, { tooltipDismissVersion }) => {
          const key = JSON.stringify([worktree.project, worktree.path])
          const isOpening = opening === worktree.path
          const rowError = rowErrors[key] || worktree.error
          const starting =
            !!worktree.operation || isOpening || worktree.editor === 'starting'
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
            <>
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
                  <PickerAction
                    tone="secondary"
                    className="worktree-open"
                    aria-busy={starting}
                    aria-disabled={isOpening || unavailable}
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
                      <WorktreeName color={worktree.color}>
                        {basename(worktree.path)}
                      </WorktreeName>
                      <span className="worktree-branch">
                        {worktree.branch ?? 'Detached HEAD'}
                      </span>
                    </span>
                  </PickerAction>
                </div>
              </Tooltip>
              <div className="worktree-delete">
                <DeleteWorktree worktree={worktree} connected={connected} />
              </div>
            </>
          )
        }}
      />
    </UIProvider>
  )
}
