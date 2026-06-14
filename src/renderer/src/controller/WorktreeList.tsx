import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Badge,
  Box,
  Card,
  Flex,
  ScrollArea,
  Separator,
  Spinner,
  Text,
  TextField,
} from '@radix-ui/themes'
import type { CreateWorktreeData } from '../../../api/server/generated'
import { useSearchableList } from '../components/useSearchableList'
import type { Worktree } from './worktrees'
import { WorktreeRow, worktreeLabel } from './WorktreeRow'

type CreateValues = CreateWorktreeData['body']

type WorktreeListProps = {
  worktrees: Worktree[]
  busyIds: ReadonlySet<string>
  pendingCreate: CreateValues | null
  onOpen: (worktreeId: string) => void
  onDelete: (worktreeId: string, deleteBranch: boolean) => void
  onRemoveRepository: (worktreeId: string, mainWorktreePath: string) => void
}

const getWorktreeText = (worktree: Worktree): string =>
  `${worktreeLabel(worktree)} ${worktree.path}`

export function WorktreeList({
  worktrees,
  busyIds,
  pendingCreate,
  onOpen,
  onDelete,
  onRemoveRepository,
}: WorktreeListProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Focus the search box as soon as the worktrees window opens.
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const handleSelect = useCallback(
    (worktree: Worktree) => {
      if (!busyIds.has(worktree.worktreeId)) {
        onOpen(worktree.worktreeId)
      }
    },
    [busyIds, onOpen],
  )

  const { filtered, onKeyDown, getItemProps } = useSearchableList({
    items: worktrees,
    getText: getWorktreeText,
    query,
    onSelect: handleSelect,
  })

  const hasWorktrees = worktrees.length > 0
  const noMatches = hasWorktrees && filtered.length === 0

  return (
    <Flex direction="column" gap="2">
      <TextField.Root
        ref={searchRef}
        value={query}
        placeholder="Search worktrees…"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />

      <Card>
        <ScrollArea type="auto" scrollbars="vertical" style={{ height: 360 }}>
          <Box px="1" role="listbox">
            {!hasWorktrees && !pendingCreate ? (
              <EmptyState text="No worktrees yet." />
            ) : noMatches && !pendingCreate ? (
              <EmptyState text="No worktrees match your search." />
            ) : (
              <>
                {filtered.map((worktree, index) => (
                  <Box key={worktree.worktreeId}>
                    {index > 0 && <Separator size="4" />}
                    <WorktreeRow
                      worktree={worktree}
                      busy={busyIds.has(worktree.worktreeId)}
                      itemProps={getItemProps(index)}
                      onDelete={(deleteBranch) =>
                        onDelete(worktree.worktreeId, deleteBranch)
                      }
                      onRemoveRepository={() =>
                        onRemoveRepository(
                          worktree.worktreeId,
                          worktree.mainWorktreePath,
                        )
                      }
                    />
                  </Box>
                ))}
                {pendingCreate && (
                  <Box>
                    {filtered.length > 0 && <Separator size="4" />}
                    <PendingCreateRow values={pendingCreate} />
                  </Box>
                )}
              </>
            )}
          </Box>
        </ScrollArea>
      </Card>
    </Flex>
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <Flex align="center" justify="center" p="6">
      <Text color="gray">{text}</Text>
    </Flex>
  )
}

function PendingCreateRow({
  values,
}: {
  values: CreateValues
}): React.JSX.Element {
  return (
    <Flex align="center" justify="between" gap="3" px="2" py="3">
      <Flex direction="column" gap="1" minWidth="0">
        <Flex align="center" gap="2">
          <Text weight="medium" truncate>
            {values.newBranch || values.baseBranch}
          </Text>
          <Badge color="iris" variant="soft" radius="full">
            creating
          </Badge>
        </Flex>
        <Text size="1" color="gray" truncate title={values.worktreePath}>
          {values.worktreePath}
        </Text>
      </Flex>
      <Spinner />
    </Flex>
  )
}
