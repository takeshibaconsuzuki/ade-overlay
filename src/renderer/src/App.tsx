import { useEffect, useState } from 'react'
import {
  Button,
  Notice,
  Spinner,
  Tooltip,
  UIProvider,
  WorktreeName,
} from '../../shared/ui/components'
import { CreateWorktree, WorktreeActions } from './components/worktree-actions'
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
    openEditor,
    openBootstrapLog,
    stopEditor,
    clearError,
  } = useCompanion()
  const [search, setSearch] = useState('')
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
  const worktrees = [...matches].sort((a, b) => {
    const aOpen = a.editorServer !== 'stopped'
    const bOpen = b.editorServer !== 'stopped'
    if (aOpen !== bOpen) return aOpen ? -1 : 1
    if (!aOpen) return 0
    return (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)
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
            worktree.editorServer === 'stopping' ||
            worktree.missing
          )
        }
        resultsKey={resultsKey}
        resetVersion={resetVersion}
        onOpen={(worktree) => {
          // Intentional: a row stays unavailable for as long as it is opening,
          // including while its page loads after another row was selected.
          if (!worktree.opening) openEditor(worktree)
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
              <Button tone="secondary" onClick={reconnect}>
                Reconnect
              </Button>
              <Button
                tone="secondary"
                busy={loading && connected}
                disabled={!connected}
                onClick={refresh}
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
          const isOpening = !!worktree.opening
          const rowError = worktree.error
          const stopping = worktree.editorServer === 'stopping'
          const starting =
            !!worktree.operation ||
            isOpening ||
            stopping ||
            worktree.editorServer === 'starting'
          const showError = !!rowError && !starting
          const unavailable =
            !connected ||
            worktree.prunable ||
            !!worktree.operation ||
            stopping ||
            worktree.missing
          const detail =
            worktree.operation === 'creating'
              ? 'Creating worktree'
              : worktree.operation === 'deleting'
                ? 'Deleting worktree'
                : stopping
                  ? 'Stopping VS Code'
                  : (worktree.editorServerDetail ?? 'Opening VS Code')
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
                            : `Editor ${worktree.editorServer}`
                      }
                    >
                      {starting ? (
                        <Spinner />
                      ) : (
                        <span
                          className={`editor-dot ${worktree.editorServer === 'running' ? 'running' : ''}`}
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
                <WorktreeActions
                  worktree={worktree}
                  connected={connected}
                  opening={isOpening}
                  onStopEditor={() => stopEditor(worktree)}
                  onOpenBootstrapLog={() => openBootstrapLog(worktree)}
                />
              </div>
            </>
          )
        }}
      />
    </UIProvider>
  )
}
