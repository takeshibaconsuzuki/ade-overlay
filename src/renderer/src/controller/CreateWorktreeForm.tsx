import { useState } from 'react'
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
import type { CreateWorktreeData } from '../../../api/server/generated'
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
  const [worktreePath, setWorktreePath] = useState('')

  const hasRepositories = repositories.length > 0
  // Fall back to the first repository until the user picks one explicitly.
  const selectedRepository =
    repository || repositories[0]?.mainWorktreePath || ''
  const canSubmit =
    !busy &&
    selectedRepository.trim() !== '' &&
    baseBranch.trim() !== '' &&
    worktreePath.trim() !== ''

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
      setWorktreePath('')
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
                  onChange={(event) => setBaseBranch(event.target.value)}
                  placeholder="main"
                />
              </Field>

              <Field label="New branch (optional)">
                <TextField.Root
                  value={newBranch}
                  onChange={(event) => setNewBranch(event.target.value)}
                  placeholder="feature/my-change"
                />
              </Field>

              <Field label="Worktree path">
                <TextField.Root
                  value={worktreePath}
                  onChange={(event) => setWorktreePath(event.target.value)}
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
