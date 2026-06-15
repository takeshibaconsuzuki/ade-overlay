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
  dismissCreationError,
  openCode,
  openCreationLogs,
  removeRepository,
  type CreateWorktreeData,
} from '../../../api/server/generated'
import { useWorktreeStream } from './worktrees'
import { useEditorSessionStream } from './editorSessions'
import { logger } from '../logger'
import { RECENT_WORKTREE_EDITOR_KEY, setCacheItem } from '../persistentCache'
import { WorktreeList } from './WorktreeList'
import { CreateWorktreeForm } from './CreateWorktreeForm'

type CreateValues = CreateWorktreeData['body']

export function App(): React.JSX.Element {
  const { snapshot, connected } = useWorktreeStream()
  const sessionStatuses = useEditorSessionStream()
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const [addingRepository, setAddingRepository] = useState(false)
  const [creating, setCreating] = useState(false)
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
      // `creating` only guards the (fast) enqueue round-trip so the button
      // can't double-submit; the actual creation progress is shown by the
      // optimistic row from the worktree stream. Always clear it before
      // returning.
      setCreating(true)
      try {
        const { error } = await createWorktree({ body: values })
        if (error) {
          logger.error({ values, err: error }, 'create worktree failed')
          setError(messageOf(error, 'Failed to create worktree'))
          return false
        }
        logger.info({ worktreePath: values.worktreePath }, 'queued worktree')
        return true
      } finally {
        setCreating(false)
      }
    },
    [],
  )

  const handleOpenCreationLogs = useCallback(
    async (worktreeId: string): Promise<void> => {
      setError(null)
      logger.info({ worktreeId }, 'opening creation logs')
      const { error } = await openCreationLogs({ path: { worktreeId } })
      if (error) {
        logger.error({ worktreeId, err: error }, 'open creation logs failed')
        setError(messageOf(error, 'Failed to open creation logs'))
      }
    },
    [],
  )

  const handleDismissCreationError = useCallback(
    async (worktreeId: string): Promise<void> => {
      setError(null)
      logger.info({ worktreeId }, 'dismissing creation error')
      const { error } = await dismissCreationError({ path: { worktreeId } })
      if (error) {
        logger.error({ worktreeId, err: error }, 'dismiss creation failed')
        setError(messageOf(error, 'Failed to dismiss error'))
      }
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
    <Container size="2" px="5" pt="5" className="app-container">
      <Flex direction="column" gap="4" className="app-main">
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
          sessionStatuses={sessionStatuses}
          onOpen={handleOpenCode}
          onDelete={handleDelete}
          onRemoveRepository={handleRemoveRepository}
          onOpenCreationLogs={handleOpenCreationLogs}
          onDismissCreationError={handleDismissCreationError}
        />

        <CreateWorktreeForm
          repositories={repositories}
          busy={creating}
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
