import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Flex,
  Heading,
  Spinner,
} from '@radix-ui/themes'
import { TriangleAlert } from 'lucide-react'
import { useCallback, useState } from 'react'
import { WORKTREE_DIRTY_ERROR_CODE } from '../../../api/server/config'
import {
  addRepository,
  createWorktree,
  deleteWorktree,
  dismissCreationError,
  openCreationLogs,
  openWorktree,
  removeRepository,
  type CreateWorktreeData,
} from '../../../api/server/generated'
import { HBox, VBox } from '../components/Box'
import { logger } from '../logger'
import styles from './App.module.css'
import { CreateWorktreeForm } from './CreateWorktreeForm'
import { useEditorSessionStream } from './editorSessions'
import { WorktreeList } from './WorktreeList'
import { useWorktreeStream } from './worktrees'

type CreateValues = CreateWorktreeData['body']

export function App(): React.JSX.Element {
  const { snapshot, connected } = useWorktreeStream()
  const sessionStatuses = useEditorSessionStream()
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const [addingRepository, setAddingRepository] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forcePrompt, setForcePrompt] = useState<{
    worktreeId: string
    deleteBranch: boolean
    message: string
  } | null>(null)

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
    const [repositoryPath] = await window.desktop.chooseFiles({
      title: 'Select a Git repository',
      allowed: ['d'],
    })
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

  const runDelete = useCallback(
    async (
      worktreeId: string,
      deleteBranch: boolean,
      force: boolean,
    ): Promise<void> => {
      setError(null)
      logger.info({ worktreeId, deleteBranch, force }, 'deleting worktree')
      markBusy(worktreeId, true)
      const { error } = await deleteWorktree({
        path: { worktreeId },
        body: { deleteBranch, force },
      })
      if (error) {
        // A non-forced delete of a worktree with uncommitted/untracked changes
        // is recoverable: prompt the user to force or cancel instead of just
        // surfacing the failure.
        if (!force && codeOf(error) === WORKTREE_DIRTY_ERROR_CODE) {
          logger.info(
            { worktreeId },
            'worktree has changes, prompting to force',
          )
          setForcePrompt({
            worktreeId,
            deleteBranch,
            message: messageOf(error, 'Worktree has uncommitted changes.'),
          })
        } else {
          logger.error({ worktreeId, err: error }, 'delete worktree failed')
          setError(messageOf(error, 'Failed to delete worktree'))
        }
      } else {
        logger.info({ worktreeId }, 'deleted worktree')
      }
      markBusy(worktreeId, false)
    },
    [markBusy],
  )

  const handleDelete = useCallback(
    (worktreeId: string, deleteBranch: boolean): void => {
      void runDelete(worktreeId, deleteBranch, false)
    },
    [runDelete],
  )

  const handleConfirmForceDelete = useCallback((): void => {
    if (!forcePrompt) {
      return
    }
    const { worktreeId, deleteBranch } = forcePrompt
    setForcePrompt(null)
    void runDelete(worktreeId, deleteBranch, true)
  }, [forcePrompt, runDelete])

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

  const handleOpenWorktree = useCallback(
    async (worktreeId: string): Promise<void> => {
      setError(null)
      logger.info({ worktreeId }, 'opening worktree editor')
      markBusy(worktreeId, true)
      const { error } = await openWorktree({ path: { worktreeId } })
      if (error) {
        logger.error({ worktreeId, err: error }, 'open editor failed')
        setError(messageOf(error, 'Failed to open editor'))
      }
      // The server records the selection (`selectedWorktreeId`); no client-side
      // copy — that's what used to drift from the server's source of truth.
      markBusy(worktreeId, false)
    },
    [markBusy],
  )

  const { worktrees, repositories } = snapshot

  return (
    <VBox className={styles.windowContent} height="100%" justify="start" p="2">
      <HBox>
        <HBox justify="start" gap="3">
          <Heading size="6">Worktrees</Heading>
          <Badge
            color={connected ? 'green' : 'gray'}
            variant="soft"
            radius="full"
          >
            {connected ? 'Live' : 'Connecting…'}
          </Badge>
        </HBox>
        <Button onClick={handleAddRepository} disabled={addingRepository}>
          <Spinner loading={addingRepository} />
          Add repository
        </Button>
      </HBox>

      {error && (
        <Callout.Root role="alert" color="red" variant="surface">
          <Callout.Icon>
            <TriangleAlert size={16} />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      <WorktreeList
        worktrees={worktrees}
        busyIds={busyIds}
        sessionStatuses={sessionStatuses}
        onOpen={handleOpenWorktree}
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

      <AlertDialog.Root
        open={forcePrompt !== null}
        onOpenChange={(open) => {
          if (!open) {
            setForcePrompt(null)
          }
        }}
      >
        <AlertDialog.Content maxWidth="450px">
          <AlertDialog.Title>Force delete worktree?</AlertDialog.Title>
          <AlertDialog.Description size="2">
            {forcePrompt?.message} Forcing will discard those changes
            permanently.
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button color="red" onClick={handleConfirmForceDelete}>
                Force delete
              </Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </VBox>
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

function codeOf(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    typeof (error as { error: unknown }).error === 'string'
  ) {
    return (error as { error: string }).error
  }
  return undefined
}
