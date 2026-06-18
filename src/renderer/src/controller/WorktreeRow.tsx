import {
  Badge,
  Box,
  DropdownMenu,
  IconButton,
  Spinner,
  Text,
  Tooltip,
} from '@radix-ui/themes'
import { CircleAlert, Ellipsis } from 'lucide-react'
import type { EditorSessionStatusValue } from '../../../api/server/editor'
import { HBox, VBox } from '../components/Box'
import type { SearchableItemProps } from '../hooks/useSearchableList'
import { worktreeBranch, worktreeName } from './worktreeLabels'
import styles from './WorktreeRow.module.css'
import type { Worktree } from './worktrees'

type WorktreeRowProps = {
  worktree: Worktree
  busy: boolean
  sessionStatus: EditorSessionStatusValue
  itemProps: SearchableItemProps
  onDelete: (deleteBranch: boolean) => void
  onRemoveRepository: () => void
  onOpenCreationLogs: () => void
  onDismissCreationError: () => void
}

export function WorktreeRow({
  worktree,
  busy,
  sessionStatus,
  itemProps,
  onDelete,
  onRemoveRepository,
  onOpenCreationLogs,
  onDismissCreationError,
}: WorktreeRowProps): React.JSX.Element {
  const isMain = worktree.isMain
  const isFailed = worktree.creationState === 'failed'
  const isCreating = worktree.creationState === 'creating'
  const isBootstrapping = worktree.creationState === 'bootstrapping'
  const isCreationPending = isCreating || isBootstrapping
  const showDestructiveActions = !isCreationPending
  const secondary =
    isFailed && worktree.creationError
      ? worktree.creationError
      : worktreeBranch(worktree)

  return (
    <HBox
      aria-disabled={busy || !worktree.isOpenable}
      className={styles.row}
      {...itemProps}
      p="2"
    >
      <HBox width="32px" justify="center" flexShrink="0">
        <LeadingIndicator
          worktree={worktree}
          busy={busy}
          sessionStatus={sessionStatus}
          onDismissCreationError={onDismissCreationError}
        />
      </HBox>

      <VBox flexGrow="1" minWidth="0" gap="1">
        <HBox justify="start">
          <Text size="2" weight="medium" title={worktree.path}>
            {worktreeName(worktree)}
          </Text>
          {isMain && <Badge color="gray">main</Badge>}
          {isCreating && <Badge color="blue">creating</Badge>}
          {isBootstrapping && <Badge color="blue">bootstrapping</Badge>}
          {worktree.isDetached && <Badge color="amber">detached</Badge>}
          {worktree.isPrunable && <Badge color="orange">prunable</Badge>}
        </HBox>
        <Text
          size="1"
          color={isFailed ? 'red' : 'gray'}
          truncate
          title={secondary}
        >
          {secondary}
        </Text>
      </VBox>

      {!busy && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton
              aria-label="Worktree actions"
              variant="ghost"
              color="gray"
              onClick={(event) => event.stopPropagation()}
            >
              <Ellipsis size={18} />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content onClick={(event) => event.stopPropagation()}>
            {worktree.hasCreationLogs && (
              <DropdownMenu.Item onSelect={() => onOpenCreationLogs()}>
                Open creation logs
              </DropdownMenu.Item>
            )}
            {showDestructiveActions && (
              <>
                {worktree.hasCreationLogs && <DropdownMenu.Separator />}
                {!isMain && (
                  <DropdownMenu.Item onSelect={() => onDelete(false)}>
                    Delete worktree
                  </DropdownMenu.Item>
                )}
                {!isMain && worktree.branchName && (
                  <DropdownMenu.Item onSelect={() => onDelete(true)}>
                    Delete worktree and branch
                  </DropdownMenu.Item>
                )}
                {!isMain && <DropdownMenu.Separator />}
                <DropdownMenu.Item onSelect={() => onRemoveRepository()}>
                  Remove repository
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      )}
    </HBox>
  )
}

/**
 * Leading state glyph: a spinner while busy or creation is pending, a clickable
 * error icon when a creation failed, otherwise a session status marker.
 */
function LeadingIndicator({
  worktree,
  busy,
  sessionStatus,
  onDismissCreationError,
}: {
  worktree: Worktree
  busy: boolean
  sessionStatus: EditorSessionStatusValue
  onDismissCreationError: () => void
}): React.JSX.Element {
  if (
    busy ||
    worktree.creationState === 'creating' ||
    worktree.creationState === 'bootstrapping'
  ) {
    return <Spinner />
  }

  if (worktree.creationState === 'failed') {
    return (
      <Tooltip content="Creation failed — click to dismiss">
        <IconButton
          aria-label="Dismiss creation error"
          color="red"
          variant="soft"
          onClick={(event) => {
            event.stopPropagation()
            onDismissCreationError()
          }}
        >
          <CircleAlert size={16} />
        </IconButton>
      </Tooltip>
    )
  }

  return <SessionDot status={sessionStatus} />
}

const SESSION_DOT: Record<
  EditorSessionStatusValue,
  { className: string; label: string }
> = {
  off: { className: styles.dotOff, label: 'Editor stopped' },
  starting: { className: styles.dotOff, label: 'Editor starting' },
  on: { className: styles.dotOn, label: 'Editor running' },
}

function SessionDot({
  status,
}: {
  status: EditorSessionStatusValue
}): React.JSX.Element {
  if (status === 'starting') {
    return (
      <Tooltip content={SESSION_DOT.starting.label}>
        <Spinner />
      </Tooltip>
    )
  }

  const { className, label } = SESSION_DOT[status]
  return (
    <Tooltip content={label}>
      <Box aria-label={label} className={`${styles.dot} ${className}`} />
    </Tooltip>
  )
}
