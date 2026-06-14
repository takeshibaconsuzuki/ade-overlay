import { useEffect, useState } from 'react'
import {
  Button,
  Callout,
  Card,
  Flex,
  Select,
  Spinner,
  Text,
  TextField,
} from '@radix-ui/themes'
import {
  previewWorktreePath,
  type CreateWorktreeData,
} from '../../../api/server/generated'
import type { Repository } from './worktrees'

type CreateValues = CreateWorktreeData['body']

type CreateWorktreeFormProps = {
  repositories: Repository[]
  busy: boolean
  onCreate: (values: CreateValues) => Promise<boolean>
}

export function CreateWorktreeForm({
  repositories,
  busy,
  onCreate,
}: CreateWorktreeFormProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [repository, setRepository] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [generatedWorktreePath, setGeneratedWorktreePath] = useState('')
  const [manualWorktreePath, setManualWorktreePath] = useState<string | null>(
    null,
  )

  const hasRepositories = repositories.length > 0
  // Fall back to the first repository until the user picks one explicitly.
  const selectedRepository =
    repository || repositories[0]?.mainWorktreePath || ''
  const trimmedBaseBranch = baseBranch.trim()
  const trimmedNewBranch = newBranch.trim()
  const templateBranch = trimmedNewBranch || trimmedBaseBranch
  const worktreePath = manualWorktreePath ?? generatedWorktreePath
  const canSubmit =
    !busy &&
    selectedRepository.trim() !== '' &&
    baseBranch.trim() !== '' &&
    worktreePath.trim() !== ''

  useEffect(() => {
    let canceled = false

    async function updatePreview(): Promise<void> {
      if (!selectedRepository || !trimmedBaseBranch || !templateBranch) {
        if (!canceled) {
          setGeneratedWorktreePath('')
        }
        return
      }

      const { data } = await previewWorktreePath({
        body: {
          mainWorktreePath: selectedRepository,
          baseBranch: trimmedBaseBranch,
          newBranch: trimmedNewBranch || undefined,
        },
      })

      if (!canceled) {
        setGeneratedWorktreePath(data?.worktreePath ?? '')
      }
    }

    void updatePreview()

    return () => {
      canceled = true
    }
  }, [
    baseBranch,
    newBranch,
    selectedRepository,
    templateBranch,
    trimmedBaseBranch,
    trimmedNewBranch,
  ])

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) {
      return
    }
    const created = await onCreate({
      mainWorktreePath: selectedRepository,
      baseBranch: baseBranch.trim(),
      newBranch: newBranch.trim() || undefined,
      worktreePath: worktreePath.trim(),
    })
    if (created) {
      setNewBranch('')
      setManualWorktreePath(null)
    }
  }

  return (
    <Flex direction="column" gap="2">
      <Button variant="soft" onClick={() => setOpen((value) => !value)}>
        <Text>{open ? '▾' : '▸'}</Text>
        Create worktree
      </Button>

      {open && (
        <Card>
          <form onSubmit={handleSubmit}>
            <Flex direction="column" gap="3">
              {!hasRepositories && (
                <Callout.Root color="gray">
                  <Callout.Text>
                    No tracked repositories yet — add one to create worktrees.
                  </Callout.Text>
                </Callout.Root>
              )}

              <Field label="Repository">
                <Select.Root
                  value={selectedRepository}
                  onValueChange={setRepository}
                  disabled={!hasRepositories}
                >
                  <Select.Trigger
                    placeholder="Select a repository"
                    style={{ width: '100%' }}
                  />
                  <Select.Content>
                    {repositories.map((repo) => (
                      <Select.Item
                        key={repo.mainWorktreePath}
                        value={repo.mainWorktreePath}
                      >
                        {repo.mainWorktreePath}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Field>

              <Field label="Base branch">
                <TextField.Root
                  value={baseBranch}
                  onChange={(event) => {
                    const nextBaseBranch = event.target.value
                    setBaseBranch(nextBaseBranch)
                    if (!nextBaseBranch.trim() && !newBranch.trim()) {
                      setManualWorktreePath(null)
                    }
                  }}
                  placeholder="main"
                />
              </Field>

              <Field label="New branch (optional)">
                <TextField.Root
                  value={newBranch}
                  onChange={(event) => {
                    const nextNewBranch = event.target.value
                    setNewBranch(nextNewBranch)
                    if (!nextNewBranch.trim()) {
                      setManualWorktreePath(null)
                    }
                  }}
                  placeholder="feature/my-change"
                />
              </Field>

              <Field label="Worktree path">
                <TextField.Root
                  value={worktreePath}
                  onChange={(event) => {
                    const nextPath = event.target.value
                    setManualWorktreePath(
                      nextPath === generatedWorktreePath ? null : nextPath,
                    )
                  }}
                  placeholder="~/worktrees/my-change"
                />
              </Field>

              <Flex justify="end">
                <Button type="submit" disabled={!canSubmit}>
                  <Spinner loading={busy} />
                  Create
                </Button>
              </Flex>
            </Flex>
          </form>
        </Card>
      )}
    </Flex>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Flex direction="column" gap="1">
      <Text as="label" size="2" weight="medium">
        {label}
      </Text>
      {children}
    </Flex>
  )
}
