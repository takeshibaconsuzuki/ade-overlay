import {
  Badge,
  Box,
  DropdownMenu,
  Flex,
  IconButton,
  Spinner,
  Text,
  Tooltip,
} from '@radix-ui/themes'
import { CircleAlert, Ellipsis } from 'lucide-react'
import type { EditorSessionStatusValue } from '../../../api/server/editor'
import type { Worktree } from './worktrees'
import type { SearchableItemProps } from '../components/useSearchableList'

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
  const isMain = worktree.path === worktree.mainWorktreePath
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
    <Box
      className="worktree-row"
      aria-disabled={busy || !worktree.isOpenable}
      {...itemProps}
    >
      {/* Leading status column. Its width is shared across all rows via the
          list's subgrid, so it collapses to the widest glyph and every row's
          text stays aligned. */}
      <Flex align="center" justify="center">
        <LeadingIndicator
          worktree={worktree}
          busy={busy}
          sessionStatus={sessionStatus}
          onDismissCreationError={onDismissCreationError}
        />
      </Flex>

      <Flex direction="column" gap="1" minWidth="0">
        <Flex align="center" gap="2">
          <Text weight="medium" truncate title={worktree.path}>
            {worktreeName(worktree)}
          </Text>
          {isMain && (
            <Badge color="iris" variant="soft" radius="full">
              main
            </Badge>
          )}
          {isCreating && (
            <Badge color="iris" variant="soft" radius="full">
              creating
            </Badge>
          )}
          {isBootstrapping && (
            <Badge color="iris" variant="soft" radius="full">
              bootstrapping
            </Badge>
          )}
          {worktree.isDetached && (
            <Badge color="amber" variant="soft" radius="full">
              detached
            </Badge>
          )}
          {worktree.isPrunable && (
            <Badge color="tomato" variant="soft" radius="full">
              prunable
            </Badge>
          )}
        </Flex>
        <Text
          size="1"
          color={isFailed ? 'tomato' : 'gray'}
          truncate
          title={secondary}
        >
          {secondary}
        </Text>
      </Flex>

      {!busy && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton
              variant="ghost"
              color="gray"
              radius="full"
              aria-label="Worktree actions"
              onClick={(event) => event.stopPropagation()}
              // Ghost buttons ship a negative margin for optical inline
              // alignment; cancel it so the button honors the row padding
              // and sits symmetrically with the left-aligned text.
              style={{ margin: 0 }}
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
                  <DropdownMenu.Item
                    color="red"
                    onSelect={() => onDelete(false)}
                  >
                    Delete worktree
                  </DropdownMenu.Item>
                )}
                {!isMain && worktree.branchName && (
                  <DropdownMenu.Item
                    color="red"
                    onSelect={() => onDelete(true)}
                  >
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
    </Box>
  )
}

/**
 * Leading state glyph: a spinner while busy or creation is pending, a clickable
 * error icon when a creation failed, otherwise a dot for the VS Code session
 * (off/starting/on).
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
          variant="ghost"
          color="tomato"
          radius="full"
          aria-label="Dismiss creation error"
          onClick={(event) => {
            event.stopPropagation()
            onDismissCreationError()
          }}
          style={{ margin: 0 }}
        >
          <CircleAlert size={18} />
        </IconButton>
      </Tooltip>
    )
  }

  return <SessionDot status={sessionStatus} />
}

const SESSION_DOT: Record<
  EditorSessionStatusValue,
  { color: string; label: string }
> = {
  off: { color: 'var(--gray-7)', label: 'Editor stopped' },
  starting: { color: 'var(--amber-9)', label: 'Editor starting' },
  on: { color: 'var(--grass-9)', label: 'Editor running' },
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

  const { color, label } = SESSION_DOT[status]
  return (
    <Tooltip content={label}>
      <Box
        aria-label={label}
        width="8px"
        height="8px"
        style={{ borderRadius: '50%', backgroundColor: color }}
      />
    </Tooltip>
  )
}

/** The worktree directory name, used as the primary label. */
export function worktreeName(worktree: Worktree): string {
  return worktree.path.split('/').pop() || worktree.path
}

/** The branch the worktree is on, used as the secondary label. */
export function worktreeBranch(worktree: Worktree): string {
  if (worktree.branchName) {
    return worktree.branchName
  }
  if (worktree.isDetached && worktree.head) {
    return `detached @ ${worktree.head.slice(0, 7)}`
  }
  return '—'
}

export function worktreeLabel(worktree: Worktree): string {
  return `${worktreeName(worktree)} ${worktreeBranch(worktree)}`
}
