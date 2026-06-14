import { useCallback, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Container,
  Flex,
  Heading,
  Spinner,
} from '@radix-ui/themes'
import {
  addRepository,
  createWorktree,
  deleteWorktree,
  openCode,
  removeRepository,
  type CreateWorktreeData,
} from '../../../api/server/generated'
import { useWorktreeStream } from './worktrees'
import { logger } from '../logger'
import { RECENT_WORKTREE_EDITOR_KEY, setCacheItem } from '../persistentCache'
import { WorktreeList } from './WorktreeList'
import { CreateWorktreeForm } from './CreateWorktreeForm'

type CreateValues = CreateWorktreeData['body']

export function App(): React.JSX.Element {
  const { snapshot, connected } = useWorktreeStream()
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const [addingRepository, setAddingRepository] = useState(false)
  const [pendingCreate, setPendingCreate] = useState<CreateValues | null>(null)
  const [error, setError] = useState<string | null>(null)

  const markBusy = useCallback((worktreeId: string, busy: boolean): void => {
    setBusyIds((current) => {
      const next = new Set(current)
      if (busy) {
        next.add(worktreeId)
      } else {
        next.delete(worktreeId)
      }
      return next
    })
  }, [])

  const handleAddRepository = useCallback(async (): Promise<void> => {
    if (!window.desktop) {
      setError('Repository picker is unavailable')
      return
    }
    setError(null)
    const repositoryPath = await window.desktop.selectRepository()
    if (!repositoryPath) {
      return
    }
    setAddingRepository(true)
    logger.info({ repositoryPath }, 'adding repository')
    const { error } = await addRepository({ body: { repositoryPath } })
    if (error) {
      logger.error({ repositoryPath, err: error }, 'add repository failed')
      setError(messageOf(error, 'Failed to add repository'))
    } else {
      logger.info({ repositoryPath }, 'added repository')
    }
    setAddingRepository(false)
  }, [])

  const handleRemoveRepository = useCallback(
    async (worktreeId: string, mainWorktreePath: string): Promise<void> => {
      setError(null)
      logger.info({ mainWorktreePath }, 'removing repository')
      markBusy(worktreeId, true)
      const { error } = await removeRepository({ body: { mainWorktreePath } })
      if (error) {
        logger.error(
          { mainWorktreePath, err: error },
          'remove repository failed',
        )
        setError(messageOf(error, 'Failed to remove repository'))
      } else {
        logger.info({ mainWorktreePath }, 'removed repository')
      }
      markBusy(worktreeId, false)
    },
    [markBusy],
  )

  const handleDelete = useCallback(
    async (worktreeId: string, deleteBranch: boolean): Promise<void> => {
      setError(null)
      logger.info({ worktreeId, deleteBranch }, 'deleting worktree')
      markBusy(worktreeId, true)
      const { error } = await deleteWorktree({
        path: { worktreeId },
        body: { deleteBranch },
      })
      if (error) {
        logger.error({ worktreeId, err: error }, 'delete worktree failed')
        setError(messageOf(error, 'Failed to delete worktree'))
      } else {
        logger.info({ worktreeId }, 'deleted worktree')
      }
      markBusy(worktreeId, false)
    },
    [markBusy],
  )

  const handleCreate = useCallback(
    async (values: CreateValues): Promise<boolean> => {
      setError(null)
      logger.info({ values }, 'creating worktree')
      setPendingCreate(values)
      const { error } = await createWorktree({ body: values })
      setPendingCreate(null)
      if (error) {
        logger.error({ values, err: error }, 'create worktree failed')
        setError(messageOf(error, 'Failed to create worktree'))
        return false
      }
      logger.info({ worktreePath: values.worktreePath }, 'created worktree')
      return true
    },
    [],
  )

  const handleOpenCode = useCallback(
    async (worktreeId: string): Promise<void> => {
      setError(null)
      logger.info({ worktreeId }, 'opening worktree editor')
      markBusy(worktreeId, true)
      const { error } = await openCode({ body: { worktreeId } })
      if (error) {
        logger.error({ worktreeId, err: error }, 'open editor failed')
        setError(messageOf(error, 'Failed to open editor'))
      } else {
        setCacheItem(RECENT_WORKTREE_EDITOR_KEY, worktreeId)
      }
      markBusy(worktreeId, false)
    },
    [markBusy],
  )

  const { worktrees, repositories } = snapshot

  return (
    <Container size="2" p="5">
      <Flex direction="column" gap="4">
        <Flex align="center" justify="between" gap="3">
          <Heading size="6">Worktrees</Heading>
          <Flex align="center" gap="3">
            <Badge color={connected ? 'grass' : 'gray'} variant="soft">
              {connected ? 'Live' : 'Connecting…'}
            </Badge>
            <Button onClick={handleAddRepository} disabled={addingRepository}>
              <Spinner loading={addingRepository} />
              Add repository
            </Button>
          </Flex>
        </Flex>

        {error && (
          <Callout.Root color="red" role="alert">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}

        <WorktreeList
          worktrees={worktrees}
          busyIds={busyIds}
          pendingCreate={pendingCreate}
          onOpen={handleOpenCode}
          onDelete={handleDelete}
          onRemoveRepository={handleRemoveRepository}
        />

        <CreateWorktreeForm
          repositories={repositories}
          busy={pendingCreate !== null}
          onCreate={handleCreate}
        />
      </Flex>
    </Container>
  )
}

function messageOf(error: unknown, fallback: string): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return fallback
}
