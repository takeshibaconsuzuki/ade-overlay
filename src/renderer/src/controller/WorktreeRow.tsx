import {
  Badge,
  DropdownMenu,
  Flex,
  IconButton,
  Spinner,
  Text,
} from '@radix-ui/themes'
import { Ellipsis } from 'lucide-react'
import type { Worktree } from './worktrees'
import type { SearchableItemProps } from '../components/useSearchableList'

type WorktreeRowProps = {
  worktree: Worktree
  busy: boolean
  itemProps: SearchableItemProps
  onDelete: (deleteBranch: boolean) => void
  onRemoveRepository: () => void
}

export function WorktreeRow({
  worktree,
  busy,
  itemProps,
  onDelete,
  onRemoveRepository,
}: WorktreeRowProps): React.JSX.Element {
  const isMain = worktree.path === worktree.mainWorktreePath

  return (
    <Flex
      className="worktree-row"
      align="center"
      justify="between"
      gap="3"
      px="2"
      py="3"
      aria-disabled={busy}
      {...itemProps}
    >
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
        <Text size="1" color="gray" truncate>
          {worktreeBranch(worktree)}
        </Text>
      </Flex>

      {busy ? (
        <Spinner />
      ) : (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton
              variant="ghost"
              color="gray"
              radius="full"
              aria-label="Worktree actions"
              onClick={(event) => event.stopPropagation()}
              // Ghost buttons ship a negative margin for optical inline
              // alignment; cancel it so the button honors the row padding and
              // sits symmetrically with the left-aligned text.
              style={{ margin: 0 }}
            >
              <Ellipsis size={18} />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content onClick={(event) => event.stopPropagation()}>
            <DropdownMenu.Item
              color="red"
              disabled={isMain}
              onSelect={() => onDelete(false)}
            >
              Delete worktree
            </DropdownMenu.Item>
            <DropdownMenu.Item
              color="red"
              disabled={isMain || !worktree.branchName}
              onSelect={() => onDelete(true)}
            >
              Delete worktree and branch
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={() => onRemoveRepository()}>
              Remove repository
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      )}
    </Flex>
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
