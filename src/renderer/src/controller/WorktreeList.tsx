import { Card, ScrollArea, Separator, Text, TextField } from '@radix-ui/themes'
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { KeyboardEvent } from 'react'
import { HBox, VBox } from '../components/Box'
import { useSearchableList } from '../hooks/useSearchableList'
import type {
  EditorSessionState,
  EditorSessionStatusMap,
} from './editorSessions'
import { worktreeLabel, worktreeName } from './worktreeLabels'
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
  onStopVscodeServer: (worktreeId: string) => void
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
  onStopVscodeServer,
}: WorktreeListProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Focus the search box as soon as the worktrees window opens.
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const sortedWorktrees = useMemo(
    () => sortWorktrees(worktrees, sessionStatuses),
    [sessionStatuses, worktrees],
  )

  const handleSelect = useCallback(
    (worktree: Worktree) => {
      if (worktree.isOpenable && !busyIds.has(worktree.worktreeId)) {
        onOpen(worktree.worktreeId)
      }
    },
    [busyIds, onOpen],
  )

  const {
    filtered,
    onKeyDown: handleListKeyDown,
    getItemProps,
  } = useSearchableList({
    items: sortedWorktrees,
    getText: getWorktreeText,
    query,
    onSelect: handleSelect,
  })

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        void window.desktop?.closeWindow()
        return
      }

      handleListKeyDown(event)
    },
    [handleListKeyDown],
  )

  const hasWorktrees = worktrees.length > 0
  const noMatches = hasWorktrees && filtered.length === 0

  return (
    <VBox className={styles.list} justify="start">
      <TextField.Root
        ref={searchRef}
        value={query}
        placeholder="Search worktrees…"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleSearchKeyDown}
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
                      sessionStatuses.get(worktree.worktreeId)?.status ?? 'off'
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
                    onStopVscodeServer={() =>
                      onStopVscodeServer(worktree.worktreeId)
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

function sortWorktrees(
  worktrees: Worktree[],
  sessionStatuses: EditorSessionStatusMap,
): Worktree[] {
  return [...worktrees].sort((left, right) => {
    const leftSession = sessionStatuses.get(left.worktreeId)
    const rightSession = sessionStatuses.get(right.worktreeId)
    const leftSwitchTime = switchTime(leftSession)
    const rightSwitchTime = switchTime(rightSession)

    if (leftSwitchTime !== rightSwitchTime) {
      return rightSwitchTime - leftSwitchTime
    }

    const leftDormant = leftSwitchTime === 0
    const rightDormant = rightSwitchTime === 0
    if (leftDormant !== rightDormant) {
      return leftDormant ? 1 : -1
    }

    return worktreeName(left).localeCompare(worktreeName(right))
  })
}

function switchTime(session: EditorSessionState | undefined): number {
  if (!session?.lastSwitchAt) {
    return 0
  }
  const time = Date.parse(session.lastSwitchAt)
  return Number.isNaN(time) ? 0 : time
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
