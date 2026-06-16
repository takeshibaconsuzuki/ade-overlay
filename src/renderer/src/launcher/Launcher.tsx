import { Button, Text } from '@radix-ui/themes'
import { useCallback, useEffect, useMemo } from 'react'
import { openChat, openCode } from '../../../api/server/generated'
import { HBox, VBox } from '../components/Box'
import { LiveChats } from '../components/LiveChats'
import { Titlebar } from '../components/Titlebar'
import { worktreeName } from '../controller/worktreeLabels'
import { useWorktreeStream } from '../controller/worktrees'
import { useChatStream } from '../hooks/useChatStream'
import { useCurrentWorktreeId } from '../hooks/useCurrentWorktreeId'
import { logger } from '../logger'
import {
  deleteCacheItem,
  getCacheItem,
  RECENT_WORKTREE_EDITOR_KEY,
} from '../persistentCache'
import styles from './Launcher.module.css'

/**
 * The launcher view shown in the small startup window. Its sole job is to open
 * the worktrees window via the privileged desktop bridge.
 */
export function Launcher({ title }: { title: string }): React.JSX.Element {
  const { chats } = useChatStream()
  const { snapshot } = useWorktreeStream()
  const activeWorktreeId = useCurrentWorktreeId()

  const currentWorktree = useMemo(
    () =>
      activeWorktreeId
        ? snapshot.worktrees.find(
            (worktree) => worktree.worktreeId === activeWorktreeId,
          )
        : undefined,
    [activeWorktreeId, snapshot.worktrees],
  )

  const worktreesButtonText = currentWorktree
    ? worktreeName(currentWorktree)
    : 'Worktrees'

  const handleOpenWorktrees = useCallback(async (): Promise<void> => {
    if (!window.desktop) {
      return
    }
    logger.info('opening worktrees window')
    await window.desktop.openWorktrees()
  }, [])

  const handleOpenRecentEditor = useCallback(async (): Promise<void> => {
    const worktreeId = getCacheItem(RECENT_WORKTREE_EDITOR_KEY)
    if (!worktreeId) {
      return
    }

    logger.info({ worktreeId }, 'opening recent worktree editor')
    const { error, response } = await openCode({ body: { worktreeId } })
    if (!error) {
      return
    }

    logger.error({ worktreeId, err: error }, 'open recent editor failed')
    if (response?.status === 404) {
      deleteCacheItem(RECENT_WORKTREE_EDITOR_KEY, worktreeId)
    }
  }, [])

  const handleOpenChat = useCallback(async (): Promise<void> => {
    logger.info({ worktreeId: activeWorktreeId }, 'opening chat app')
    const { error } = await openChat({ body: {} })
    if (error) {
      logger.error({ err: error }, 'open chat failed')
    }
  }, [activeWorktreeId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return
      }

      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void handleOpenWorktrees()
      } else if (key === 'w') {
        event.preventDefault()
        void handleOpenRecentEditor()
      } else if (key === 'c') {
        event.preventDefault()
        void handleOpenChat()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleOpenChat, handleOpenRecentEditor, handleOpenWorktrees])

  return (
    <VBox gap="0" height="100%">
      <Titlebar title={title} />
      <VBox
        className={styles.windowContent}
        flexGrow="1"
        minHeight="0"
        justify="start"
        gap="3"
        p="3"
      >
        <Button
          size="3"
          title={currentWorktree?.path}
          onClick={handleOpenWorktrees}
        >
          <HBox justify="start" width="100%">
            <Text as="span" truncate>
              {worktreesButtonText}
            </Text>
          </HBox>
        </Button>
        <LiveChats chats={chats} className={styles.liveChats} />
      </VBox>
    </VBox>
  )
}
