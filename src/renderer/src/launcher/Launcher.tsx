import { Button, Text } from '@radix-ui/themes'
import { useCallback, useEffect, useMemo } from 'react'
import { showChat, showEditor } from '../../../api/server/generated'
import { HBox, VBox } from '../components/Box'
import { LiveChats } from '../components/LiveChats'
import { Titlebar } from '../components/Titlebar'
import { worktreeName } from '../controller/worktreeLabels'
import { useWorktreeStream } from '../controller/worktrees'
import { useChatStream, type Chat } from '../hooks/useChatStream'
import { useCurrentWorktreeId } from '../hooks/useCurrentWorktreeId'
import { logger } from '../logger'
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

  const resolveWorktreeName = useCallback(
    (id: string | undefined): string | undefined => {
      const entry = id
        ? snapshot.worktrees.find((worktree) => worktree.worktreeId === id)
        : undefined
      return entry ? worktreeName(entry) : undefined
    },
    [snapshot.worktrees],
  )

  const handleOpenWorktrees = useCallback(async (): Promise<void> => {
    if (!window.desktop) {
      return
    }
    logger.info('opening worktrees window')
    await window.desktop.openWorktreesWindow()
  }, [])

  // Bring the editor forward on the worktree the user is currently in, without
  // switching worktrees — `showEditor` reveals the window without re-selecting.
  const handleShowEditor = useCallback(async (): Promise<void> => {
    if (!activeWorktreeId) {
      return
    }
    logger.info({ worktreeId: activeWorktreeId }, 'showing editor')
    const { error } = await showEditor({
      body: { worktreeId: activeWorktreeId },
    })
    if (error) {
      logger.error(
        { worktreeId: activeWorktreeId, err: error },
        'show editor failed',
      )
    }
  }, [activeWorktreeId])

  const handleOpenChat = useCallback(async (): Promise<void> => {
    if (!activeWorktreeId) {
      return
    }
    logger.info({ worktreeId: activeWorktreeId }, 'opening chat app')
    const { error } = await showChat({ body: { worktreeId: activeWorktreeId } })
    if (error) {
      logger.error({ err: error }, 'show chat failed')
    }
  }, [activeWorktreeId])

  // Clicking a live chat asks the server to jump to its worktree and bring the
  // chat window forward with that chat selected.
  const handleOpenLiveChat = useCallback(async (chat: Chat): Promise<void> => {
    if (!chat.terminalId || !chat.worktreeId) {
      return
    }
    const { error } = await showChat({
      body: {
        worktreeId: chat.worktreeId,
        providerId: chat.providerId,
        chatId: chat.chatId,
      },
    })
    if (error) {
      logger.error(
        { err: error, worktreeId: chat.worktreeId },
        'failed to open live chat',
      )
    }
  }, [])

  const deactivateLauncher = useCallback((): void => {
    void window.desktop?.setLauncherDormant()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return
      }

      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        deactivateLauncher()
        void handleOpenWorktrees()
      } else if (key === 'w') {
        event.preventDefault()
        deactivateLauncher()
        void handleShowEditor()
      } else if (key === 'c') {
        event.preventDefault()
        deactivateLauncher()
        void handleOpenChat()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    deactivateLauncher,
    handleOpenChat,
    handleShowEditor,
    handleOpenWorktrees,
  ])

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
        <LiveChats
          chats={chats}
          className={styles.liveChats}
          onSelect={(chat) => void handleOpenLiveChat(chat)}
          isChatDisabled={(chat) => !chat.terminalId}
          resolveWorktreeName={resolveWorktreeName}
        />
      </VBox>
    </VBox>
  )
}
