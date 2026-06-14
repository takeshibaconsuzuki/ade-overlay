import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  Card,
  Flex,
  ScrollArea,
  Separator,
  Text,
  TextField,
} from '@radix-ui/themes'
import type { EditorSessionStatusMap } from './editorSessions'
import { useSearchableList } from '../components/useSearchableList'
import type { Worktree } from './worktrees'
import { WorktreeRow, worktreeLabel } from './WorktreeRow'

type WorktreeListProps = {
  worktrees: Worktree[]
  busyIds: ReadonlySet<string>
  sessionStatuses: EditorSessionStatusMap
  onOpen: (worktreeId: string) => void
  onDelete: (worktreeId: string, deleteBranch: boolean) => void
  onRemoveRepository: (worktreeId: string, mainWorktreePath: string) => void
  onOpenCreationLogs: (worktreeId: string) => void
  onDismissCreationError: (worktreeId: string) => void
}

const getWorktreeText = (worktree: Worktree): string => worktreeLabel(worktree)

export function WorktreeList({
  worktrees,
  busyIds,
  sessionStatuses,
  onOpen,
  onDelete,
  onRemoveRepository,
  onOpenCreationLogs,
  onDismissCreationError,
}: WorktreeListProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Focus the search box as soon as the worktrees window opens.
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const handleSelect = useCallback(
    (worktree: Worktree) => {
      // Only ready worktrees can be opened; creating/failed rows are inert.
      if (
        worktree.creationState === 'ready' &&
        !busyIds.has(worktree.worktreeId)
      ) {
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

      {/* Padding lives on the Card (outside the scroll clip) so the gap around
          rows stays uniform on every side — including where a highlighted row
          meets the scroll boundary. The inner list carries no padding. */}
      <Card style={{ padding: 'var(--space-2)' }}>
        <ScrollArea
          type="scroll"
          scrollbars="vertical"
          className="scroll-clip-x"
          style={{ height: 360 }}
        >
          <Box role="listbox" className="worktree-list">
            {!hasWorktrees ? (
              <EmptyState text="No worktrees yet." />
            ) : noMatches ? (
              <EmptyState text="No worktrees match your search." />
            ) : (
              filtered.map((worktree, index) => (
                <Fragment key={worktree.worktreeId}>
                  {index > 0 && (
                    <Separator className="worktree-separator" size="4" />
                  )}
                  <WorktreeRow
                    worktree={worktree}
                    busy={busyIds.has(worktree.worktreeId)}
                    sessionStatus={
                      sessionStatuses.get(worktree.worktreeId) ?? 'off'
                    }
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
                    onOpenCreationLogs={() =>
                      onOpenCreationLogs(worktree.worktreeId)
                    }
                    onDismissCreationError={() =>
                      onDismissCreationError(worktree.worktreeId)
                    }
                  />
                </Fragment>
              ))
            )}
          </Box>
        </ScrollArea>
      </Card>
    </Flex>
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <Flex className="worktree-empty" align="center" justify="center" p="6">
      <Text color="gray">{text}</Text>
    </Flex>
  )
}
