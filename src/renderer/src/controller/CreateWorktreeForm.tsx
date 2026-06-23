import {
  Button,
  Callout,
  Card,
  Checkbox,
  Select,
  Spinner,
  Text,
  TextField,
} from '@radix-ui/themes'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  listBranches,
  previewWorktreePath,
  type CreateWorktreeData,
} from '../../../api/server/generated'
import { HBox, VBox } from '../components/Box'
import { Combobox } from '../components/Combobox'
import { logger } from '../logger'
import {
  getCacheItem,
  RECENT_WORKTREE_PROJECT_KEY,
  setCacheItem,
} from '../persistentCache'
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
  const [repository, setRepository] = useState(
    () => getCacheItem(RECENT_WORKTREE_PROJECT_KEY) ?? '',
  )
  const [baseBranch, setBaseBranch] = useState('')
  const [branchData, setBranchData] = useState<{
    repository: string
    branches: string[]
  }>({ repository: '', branches: [] })
  const [newBranch, setNewBranch] = useState('')
  const [bootstrap, setBootstrap] = useState(false)
  const [generatedWorktreePath, setGeneratedWorktreePath] = useState('')
  const [manualWorktreePath, setManualWorktreePath] = useState<string | null>(
    null,
  )

  const hasRepositories = repositories.length > 0
  const repositoryIsTracked = repositories.some(
    (repo) => repo.mainWorktreePath === repository,
  )
  // Fall back to the first repository until the user picks one explicitly, or
  // if the remembered repository is no longer tracked.
  const selectedRepository = repositoryIsTracked
    ? repository
    : repositories[0]?.mainWorktreePath || ''
  const selectedRepositoryConfig = repositories.find(
    (repo) => repo.mainWorktreePath === selectedRepository,
  )
  const hasBootstrapCommand = Boolean(
    selectedRepositoryConfig?.bootstrapCommand,
  )
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

      const { data, error } = await previewWorktreePath({
        body: {
          mainWorktreePath: selectedRepository,
          baseBranch: trimmedBaseBranch,
          newBranch: trimmedNewBranch || undefined,
        },
      })

      if (!canceled) {
        if (error) {
          logger.warn(
            { selectedRepository, err: error },
            'worktree path preview failed',
          )
        }
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

  useEffect(() => {
    if (!open || !selectedRepository) {
      return
    }

    let canceled = false

    void listBranches({ body: { mainWorktreePath: selectedRepository } }).then(
      ({ data, error }) => {
        if (canceled) {
          return
        }
        if (error) {
          logger.warn(
            { selectedRepository, err: error },
            'list branches failed',
          )
        }
        setBranchData({
          repository: selectedRepository,
          branches: error ? [] : (data?.branches ?? []),
        })
      },
    )

    return () => {
      canceled = true
    }
  }, [open, selectedRepository])

  // Only surface branches that belong to the currently selected repository so a
  // stale list never appears while a fresh fetch is in flight.
  const branches =
    branchData.repository === selectedRepository ? branchData.branches : []

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) {
      return
    }
    setOpen(false)
    const created = await onCreate({
      mainWorktreePath: selectedRepository,
      baseBranch: baseBranch.trim(),
      newBranch: newBranch.trim() || undefined,
      worktreePath: worktreePath.trim(),
      bootstrap: bootstrap && hasBootstrapCommand,
    })
    if (created) {
      setNewBranch('')
      setManualWorktreePath(null)
    }
  }

  return (
    <VBox>
      <Button variant="soft" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown /> : <ChevronRight />}
        Create worktree
      </Button>

      {open && (
        <Card>
          <form onSubmit={handleSubmit}>
            <VBox>
              {!hasRepositories && (
                <Callout.Root color="gray" variant="surface">
                  <Callout.Icon>
                    <Info size={16} />
                  </Callout.Icon>
                  <Callout.Text>
                    No tracked repositories yet — add one to create worktrees.
                  </Callout.Text>
                </Callout.Root>
              )}

              <Field label="Repository">
                <Select.Root
                  value={selectedRepository}
                  onValueChange={(nextRepository) => {
                    setRepository(nextRepository)
                    setCacheItem(RECENT_WORKTREE_PROJECT_KEY, nextRepository)
                  }}
                  disabled={!hasRepositories}
                >
                  <Select.Trigger placeholder="Select a repository" />
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
                <Combobox
                  value={baseBranch}
                  onChange={(nextBaseBranch) => {
                    setBaseBranch(nextBaseBranch)
                    if (!nextBaseBranch.trim() && !newBranch.trim()) {
                      setManualWorktreePath(null)
                    }
                  }}
                  options={branches}
                  placeholder="main"
                  disabled={!hasRepositories}
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

              <Text
                as="label"
                size="2"
                color={hasBootstrapCommand ? undefined : 'gray'}
              >
                <HBox justify="start">
                  <Checkbox
                    checked={bootstrap && hasBootstrapCommand}
                    disabled={!hasBootstrapCommand}
                    onCheckedChange={(checked) =>
                      setBootstrap(checked === true)
                    }
                  />
                  Bootstrap
                </HBox>
              </Text>

              <HBox justify="end">
                <Button type="submit" disabled={!canSubmit}>
                  <Spinner loading={busy} />
                  Create
                </Button>
              </HBox>
            </VBox>
          </form>
        </Card>
      )}
    </VBox>
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
    <VBox gap="1">
      <Text as="label" size="1" color="gray" weight="medium">
        {label}
      </Text>
      {children}
    </VBox>
  )
}
