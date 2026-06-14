import { useCallback } from 'react'
import { Button, Flex } from '@radix-ui/themes'
import { logger } from '../logger'

/**
 * The launcher view shown in the small startup window. Its sole job is to open
 * the worktrees window via the privileged desktop bridge.
 */
export function Launcher(): React.JSX.Element {
  const handleOpenWorktrees = useCallback(async (): Promise<void> => {
    if (!window.desktop) {
      return
    }
    logger.info('opening worktrees window')
    await window.desktop.openWorktrees()
  }, [])

  return (
    <Flex align="center" justify="center" height="100vh" p="4">
      <Button size="3" onClick={handleOpenWorktrees}>
        Worktrees
      </Button>
    </Flex>
  )
}
