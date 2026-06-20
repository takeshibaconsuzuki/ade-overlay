import { Badge, DropdownMenu, IconButton, Text } from '@radix-ui/themes'
import { Ellipsis } from 'lucide-react'
import type { EditorSessionStatusValue } from '../../../api/server/editor'
import { HBox, VBox } from '../components/Box'
import {
  StatusIndicator,
  type StatusIndicatorState,
} from '../components/StatusIndicator'
import type { SearchableItemProps } from '../hooks/useSearchableList'
import { worktreeBranch, worktreeColor, worktreeName } from './worktreeLabels'
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
      <HBox width="16px" justify="center" flexShrink="0">
        <LeadingIndicator
          worktree={worktree}
          busy={busy}
          sessionStatus={sessionStatus}
          onDismissCreationError={onDismissCreationError}
        />
      </HBox>

      <VBox flexGrow="1" minWidth="0" gap="1">
        <HBox justify="start">
          <Text
            size="2"
            weight="medium"
            style={{ color: worktreeColor(worktreeName(worktree)) }}
            title={worktree.path}
          >
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
    return <StatusIndicator state="busy" label="Working" />
  }

  if (worktree.creationState === 'failed') {
    return (
      <StatusIndicator
        state="error"
        label="Creation failed — click to dismiss"
        onClick={(event) => {
          event.stopPropagation()
          onDismissCreationError()
        }}
      />
    )
  }

  const { state, label } = SESSION_INDICATOR[sessionStatus]
  return <StatusIndicator state={state} label={label} />
}

const SESSION_INDICATOR: Record<
  EditorSessionStatusValue,
  { state: StatusIndicatorState; label: string }
> = {
  off: { state: 'neutral', label: 'Editor stopped' },
  starting: { state: 'busy', label: 'Editor starting' },
  on: { state: 'ok', label: 'Editor running' },
}
