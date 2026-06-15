import { Card, ScrollArea, Separator, Text, TextField } from '@radix-ui/themes'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { HBox, VBox } from '../components/Box'
import { useSearchableList } from '../hooks/useSearchableList'
import type { EditorSessionStatusMap } from './editorSessions'
import { worktreeLabel } from './worktreeLabels'
import styles from './WorktreeList.module.css'
import { WorktreeRow } from './WorktreeRow'
import type { Worktree } from './worktrees'

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
      if (worktree.isOpenable && !busyIds.has(worktree.worktreeId)) {
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
    <VBox className={styles.list} justify="start">
      <TextField.Root
        ref={searchRef}
        value={query}
        placeholder="Search worktrees…"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />

      <Card className={styles.card}>
        <ScrollArea
          className={styles.scroll}
          type="scroll"
          scrollbars="vertical"
        >
          <VBox role="listbox" gap="0">
            {!hasWorktrees ? (
              <EmptyState text="No worktrees yet." />
            ) : noMatches ? (
              <EmptyState text="No worktrees match your search." />
            ) : (
              filtered.map((worktree, index) => (
                <Fragment key={worktree.worktreeId}>
                  {index > 0 && <Separator size="4" />}
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
          </VBox>
        </ScrollArea>
      </Card>
    </VBox>
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <HBox p="5" justify="center">
      <Text size="2" color="gray">
        {text}
      </Text>
    </HBox>
  )
}
