import { useCallback } from 'react'
import { Button, Flex } from '@radix-ui/themes'
import { logger } from '../logger'
import { Titlebar } from '../components/Titlebar'

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

  // The window is frameless; the custom titlebar is the only drag handle, so
  // the rest of the surface stays free for normal pointer interaction.
  return (
    <Flex direction="column" height="100vh">
      <Titlebar title="ADE" />
      <Flex align="center" justify="center" flexGrow="1" p="4">
        <Button size="3" onClick={handleOpenWorktrees}>
          Worktrees
        </Button>
      </Flex>
    </Flex>
  )
}
