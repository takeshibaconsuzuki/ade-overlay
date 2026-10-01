import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  Worktree,
  WorktreeSnapshot,
  WorktreePathTemplates,
} from '../../../shared/companion'
import { renderWorktreePath } from '../../../shared/worktree-path-template'
import { errorMessage } from '../use-companion'
import {
  ActionMenu,
  Button,
  Field,
  Modal,
  Notice,
  SelectField,
} from '../../../shared/ui/components'

function useSubmission() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  function changeOpen(next: boolean): void {
    generation.current++
    setBusy(false)
    setError('')
    setOpen(next)
  }
  async function submit(operation: () => Promise<void>): Promise<void> {
    const current = ++generation.current
    setBusy(true)
    setError('')
    try {
      await operation()
      if (current === generation.current) changeOpen(false)
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  return { open, busy, error, changeOpen, submit }
}

export function CreateWorktree({
  snapshot,
  connected,
}: {
  snapshot: WorktreeSnapshot | null
  connected: boolean
}) {
  const {
    open,
    busy,
    error,
    changeOpen: changeSubmission,
    submit: submitOperation,
  } = useSubmission()
  const [project, setProject] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [branch, setBranch] = useState('')
  const [path, setPath] = useState('')
  const [templates, setTemplates] = useState<WorktreePathTemplates | null>(null)
  const [templateError, setTemplateError] = useState('')
  const templateGeneration = useRef(0)
  const [suggestionError, setSuggestionError] = useState({
    key: '',
    message: '',
  })
  const autofill = useRef(true)
  const clearedVariables = useRef<string | null>(null)
  const pathGeneration = useRef(0)
  const branchName = branch.trim() || baseBranch.trim()
  const suggestionKey = JSON.stringify([project, branchName])
  const pathError =
    suggestionError.key === suggestionKey ? suggestionError.message : ''

  useEffect(() => {
    if (!open || !templates || !project || !autofill.current) return
    if (clearedVariables.current === suggestionKey) return
    clearedVariables.current = null
    const generation = ++pathGeneration.current
    let active = true
    const config = templates.projects.find(
      (entry) => entry.mainWorktreePath === project,
    )
    if (!config) return
    void renderWorktreePath(
      config.worktreePathTemplate,
      config.mainWorktreePath,
      branchName,
      templates.pathStyle,
    ).then(
      (path) => {
        if (active && generation === pathGeneration.current) {
          setPath(path)
          setSuggestionError({ key: suggestionKey, message: '' })
        }
      },
      (cause) => {
        if (active && generation === pathGeneration.current)
          setSuggestionError({
            key: suggestionKey,
            message: errorMessage(cause),
          })
      },
    )
    return () => {
      active = false
    }
  }, [open, templates, project, branchName, suggestionKey])

  useEffect(
    () => () => {
      templateGeneration.current++
    },
    [],
  )

  function editPath(value: string): void {
    // Clearing arms the next variable change, without starting a request now.
    pathGeneration.current++
    autofill.current = value === ''
    clearedVariables.current = value === '' ? suggestionKey : null
    setPath(value)
    setSuggestionError({ key: '', message: '' })
    setTemplateError('')
  }

  function selectProject(value: string): void {
    setProject(value)
    setBaseBranch(
      snapshot?.worktrees.find((entry) => entry.project === value && entry.main)
        ?.branch ?? 'HEAD',
    )
  }
  function changeOpen(next: boolean): void {
    pathGeneration.current++
    const generation = ++templateGeneration.current
    if (next) {
      selectProject(snapshot?.projects[0] ?? '')
      setBranch('')
      autofill.current = true
      clearedVariables.current = null
      setPath('')
      setSuggestionError({ key: '', message: '' })
      setTemplates(null)
      setTemplateError('')
      void window.companion.getWorktreePathTemplates().then(
        (value) => {
          if (generation === templateGeneration.current) setTemplates(value)
        },
        (cause) => {
          if (generation === templateGeneration.current && autofill.current)
            setTemplateError(errorMessage(cause))
        },
      )
    }
    changeSubmission(next)
  }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    await submitOperation(() =>
      window.companion.createWorktree({
        project,
        baseBranch: baseBranch.trim(),
        branch: branch.trim(),
        path: path.trim(),
      }),
    )
  }
  return (
    <Modal
      title="Create worktree"
      description="Leave the new branch name blank to check out the base branch."
      open={open}
      onOpenChange={changeOpen}
      trigger={
        <Button disabled={!connected || !snapshot?.projects.length}>
          Create worktree
        </Button>
      }
    >
      <form className="worktree-form" onSubmit={(event) => void submit(event)}>
        <SelectField
          label="Project"
          value={project}
          onChange={selectProject}
          options={(snapshot?.projects ?? []).map((value) => ({
            value,
            label: value,
          }))}
          disabled={busy}
        />
        <Field
          label="Base branch"
          value={baseBranch}
          onChange={(event) => setBaseBranch(event.target.value)}
          placeholder="main"
          required
          disabled={busy}
        />
        <Field
          label="New branch name (optional)"
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="feature/my-change"
          disabled={busy}
        />
        <Field
          label="Worktree path"
          value={path}
          onChange={(event) => editPath(event.target.value)}
          placeholder="../my-change"
          hint="Path on the server. Relative paths start at the selected project. Clear to autofill on the next project or branch change."
          required
          disabled={busy}
        />
        {pathError && <Notice>{pathError}</Notice>}
        {templateError && <Notice>{templateError}</Notice>}
        {error && <Notice>{error}</Notice>}
        {!connected && (
          <Notice>Reconnect to the server to create a worktree.</Notice>
        )}
        <div className="dialog-actions">
          <Button tone="secondary" onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            busy={busy}
            disabled={
              !connected || !project || !baseBranch.trim() || !path.trim()
            }
          >
            Create worktree
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function WorktreeActions({
  worktree,
  connected,
  opening,
  onStopEditor,
}: {
  worktree: Worktree
  connected: boolean
  opening: boolean
  onStopEditor: () => void
}) {
  const { open, busy, error, changeOpen, submit } = useSubmission()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [watchFailure, setWatchFailure] = useState(false)
  const failure =
    watchFailure && !worktree.operation ? worktree.deletionFailure : undefined
  const dialogOpen = open || !!failure
  const removesBranch = failure?.deleteBranch ?? deleteBranch
  const label = removesBranch ? 'Delete worktree and branch' : 'Delete worktree'

  function select(removeBranch: boolean): void {
    setWatchFailure(false)
    setDeleteBranch(removeBranch)
    changeOpen(true)
  }

  function dismiss(): void {
    setWatchFailure(false)
    changeOpen(false)
  }

  async function remove(): Promise<void> {
    setWatchFailure(true)
    await submit(() =>
      window.companion.deleteWorktree({
        project: worktree.project,
        path: worktree.path,
        deleteBranch: removesBranch,
        force: !!failure?.canForce,
      }),
    )
  }

  const reason = `Actions for ${worktree.branch ?? worktree.path}`
  const deletion = worktree.main
    ? 'The main worktree cannot be deleted'
    : worktree.locked
      ? 'Unlock this worktree in Git before deleting it'
      : undefined
  const branchDeletion =
    deletion ?? (worktree.branch ? undefined : 'This worktree has no branch')

  return (
    <>
      <ActionMenu
        restoreFocus={!dialogOpen}
        items={[
          {
            label: 'Stop VS Code server',
            disabled: worktree.editor !== 'running' || opening,
            onSelect: onStopEditor,
          },
          {
            label: 'Delete worktree',
            tone: 'danger',
            disabled: !!deletion,
            title: deletion,
            onSelect: () => select(false),
          },
          {
            label: 'Delete worktree and branch',
            tone: 'danger',
            disabled: !!branchDeletion,
            title: branchDeletion,
            onSelect: () => select(true),
          },
        ]}
      >
        <Button
          ref={triggerRef}
          tone="secondary"
          className="worktree-menu-trigger"
          disabled={!connected || !!worktree.operation || worktree.missing}
          title={reason}
          aria-label={reason}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="3" cy="9" r="1.5" />
            <circle cx="9" cy="9" r="1.5" />
            <circle cx="15" cy="9" r="1.5" />
          </svg>
        </Button>
      </ActionMenu>
      <Modal
        title={
          failure
            ? failure.canForce
              ? 'Force delete worktree?'
              : 'Could not delete worktree'
            : `${label}?`
        }
        description={
          failure?.canForce
            ? `Git refused to remove this worktree. Retry with --force to permanently discard its local files and changes${removesBranch ? ' and delete its branch' : ''}?`
            : failure
              ? 'The worktree could not be removed. Review the error and files below.'
              : removesBranch
                ? 'Remove this working directory and delete its local branch, including any unmerged commits.'
                : 'Remove this working directory and keep its branch.'
        }
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next) dismiss()
        }}
        returnFocusRef={triggerRef}
      >
        <p className="delete-path">{worktree.path}</p>
        {removesBranch && (
          <p className="delete-path">Branch: {worktree.branch}</p>
        )}
        {failure && worktree.error && <Notice>{worktree.error}</Notice>}
        {!!failure?.files.length && (
          <ul className="delete-files" aria-label="Files in the worktree">
            {failure.files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        )}
        {error && <Notice>{error}</Notice>}
        <div className="dialog-actions">
          <Button tone="secondary" onClick={dismiss}>
            Cancel
          </Button>
          {(!failure || failure.canForce) && (
            <Button
              tone="danger"
              disabled={!connected || !!worktree.operation}
              busy={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Deleting…' : failure ? 'Delete with --force' : label}
            </Button>
          )}
        </div>
      </Modal>
    </>
  )
}
