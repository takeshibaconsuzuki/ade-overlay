import { useCallback, useEffect } from 'react'
import { Button, Flex } from '@radix-ui/themes'
import { openCode } from '../../../api/server/generated'
import { logger } from '../logger'
import {
  RECENT_WORKTREE_EDITOR_KEY,
  deleteCacheItem,
  getCacheItem,
} from '../persistentCache'
import { Titlebar } from '../components/Titlebar'
import { useChatStream } from './chats'
import { LiveChats } from './LiveChats'

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

  // The window is frameless; the custom titlebar is the only drag handle, so
  // the rest of the surface stays free for normal pointer interaction.
  return (
    <Flex direction="column" height="100vh">
      <Titlebar title={title} />
      <Flex direction="column" flexGrow="1" gap="4" p="4" minHeight="0">
        <Button size="3" onClick={handleOpenWorktrees} style={{ width: '100%' }}>
          Worktrees
        </Button>
        <LiveChats chats={chats} />
      </Flex>
    </Flex>
  )
}
