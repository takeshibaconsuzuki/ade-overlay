import { Button, Kbd } from '@radix-ui/themes'
import { useCallback, useEffect } from 'react'
import { openCode } from '../../../api/server/generated'
import { VBox } from '../components/Box'
import { LiveChats } from '../components/LiveChats'
import { Titlebar } from '../components/Titlebar'
import { useChatStream } from '../hooks/useChatStream'
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
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleOpenRecentEditor, handleOpenWorktrees])

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
        <Button size="3" onClick={handleOpenWorktrees}>
          Worktrees
          <Kbd>S</Kbd>
        </Button>
        <LiveChats chats={chats} className={styles.liveChats} />
      </VBox>
    </VBox>
  )
}
