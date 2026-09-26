import { useState, type FormEvent } from 'react'
import type { Worktree, WorktreeSnapshot } from '../../../shared/companion'
import { errorMessage } from '../use-companion'
import { Button, Field, Modal, Notice, SelectField } from './ui'

export function CreateWorktree({
  snapshot,
  connected,
}: {
  snapshot: WorktreeSnapshot | null
  connected: boolean
}) {
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [branch, setBranch] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function selectProject(value: string): void {
    setProject(value)
    setBaseBranch(
      snapshot?.worktrees.find((entry) => entry.project === value && entry.main)
        ?.branch ?? 'HEAD',
    )
  }
  function changeOpen(next: boolean): void {
    if (next) {
      selectProject(snapshot?.projects[0] ?? '')
      setBranch('')
      setPath('')
      setError('')
    }
    setOpen(next)
  }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await window.companion.createWorktree({
        project,
        baseBranch: baseBranch.trim(),
        branch: branch.trim(),
        path: path.trim(),
      })
      setOpen(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Create worktree"
      description="Leave the new branch name blank to check out the base branch."
      open={open}
      onOpenChange={changeOpen}
      busy={busy}
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
          onChange={(event) => setPath(event.target.value)}
          placeholder="../my-change"
          hint="Path on the server. Relative paths start at the selected project."
          required
          disabled={busy}
        />
        {error && <Notice>{error}</Notice>}
        {!connected && (
          <Notice>Reconnect to the server to create a worktree.</Notice>
        )}
        <div className="dialog-actions">
          <Button
            tone="secondary"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            busy={busy}
            disabled={
              !connected || !project || !baseBranch.trim() || !path.trim()
            }
          >
            {busy ? 'Creating…' : 'Create worktree'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function DeleteWorktree({
  worktree,
  connected,
}: {
  worktree: Worktree
  connected: boolean
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function remove(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await window.companion.deleteWorktree({
        project: worktree.project,
        path: worktree.path,
      })
      setOpen(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const reason = worktree.main
    ? 'The main worktree cannot be deleted'
    : worktree.locked
      ? 'Unlock this worktree in Git before deleting it'
      : `Delete ${worktree.branch ?? worktree.path}`

  return (
    <Modal
      title="Delete worktree?"
      description="Remove this working directory and keep its branch."
      open={open}
      onOpenChange={(next) => {
        setError('')
        setOpen(next)
      }}
      busy={busy}
      trigger={
        <Button
          tone="danger"
          disabled={!connected || worktree.main || worktree.locked}
          title={reason}
          aria-label={reason}
        >
          Delete
        </Button>
      }
    >
      <p className="delete-path">{worktree.path}</p>
      {error && <Notice>{error}</Notice>}
      <div className="dialog-actions">
        <Button tone="secondary" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          tone="danger"
          disabled={!connected}
          busy={busy}
          onClick={() => void remove()}
        >
          {busy ? 'Deleting…' : 'Delete worktree'}
        </Button>
      </div>
    </Modal>
  )
}
