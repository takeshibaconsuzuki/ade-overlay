import {
  Box,
  Button,
  Card,
  Code,
  ScrollArea,
  SegmentedControl,
  Tabs,
  Text,
} from '@radix-ui/themes'
import { useCallback, useEffect, useState } from 'react'
import {
  CHAT_PROVIDERS,
  CHAT_STATUS,
  chatProviderLabel,
  DEFAULT_CHAT_PROVIDER,
  parseChatProviderId,
  type ChatCommand,
  type ChatProviderId,
} from '../../../api/server/chats'
import {
  createTerminal,
  historicalChats,
  showChat,
} from '../../../api/server/generated'
import { HBox, VBox } from '../components/Box'
import { LiveChats } from '../components/LiveChats'
import { Titlebar } from '../components/Titlebar'
import { worktreeColor, worktreeName } from '../controller/worktreeLabels'
import { useWorktreeStream } from '../controller/worktrees'
import { formatTimestamp } from '../format'
import { useChatStream, type Chat } from '../hooks/useChatStream'
import { useCurrentWorktreeId } from '../hooks/useCurrentWorktreeId'
import {
  useTerminalStream,
  type TerminalDescriptor,
} from '../hooks/useTerminalStream'
import { logger } from '../logger'
import styles from './ChatApp.module.css'
import { Terminal } from './Terminal'

type ChatSession = {
  sessionId: string
  providerId: string
  worktreeId: string
  title?: string
  updatedAt: number
}

/**
 * The chat app: a sidebar of the current worktree's historical sessions and a
 * tabbed area of live terminals. Clicking a session resumes it in a new
 * terminal; "New chat" starts a fresh one. Terminals live in the server, so
 * reopening this window re-lists and re-attaches them.
 */
export function ChatApp({ title }: { title: string }): React.JSX.Element {
  const worktreeId = useCurrentWorktreeId()

  const { snapshot } = useWorktreeStream()
  const worktree = worktreeId
    ? snapshot.worktrees.find((entry) => entry.worktreeId === worktreeId)
    : undefined

  const resolveWorktreeName = useCallback(
    (id: string | undefined): string | undefined => {
      const entry = id
        ? snapshot.worktrees.find((w) => w.worktreeId === id)
        : undefined
      return entry ? worktreeName(entry) : undefined
    },
    [snapshot.worktrees],
  )

  const { chats } = useChatStream()
  const { terminals } = useTerminalStream()

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newChatProviderId, setNewChatProviderId] = useState<ChatProviderId>(
    DEFAULT_CHAT_PROVIDER,
  )

  // Historical sessions are read from disk (git), so they load separately and
  // only feed the Historical tab; a slow read never delays terminal display.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (!worktreeId) {
        setSessions([])
        return
      }
      const history = await historicalChats({ query: { worktreeId } })
      if (!cancelled) {
        setSessions(history.data?.sessions ?? [])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [worktreeId])

  // Electron main is the sole /chats/commands consumer. It validates commands
  // and forwards targeted focus commands here after this handler is installed.
  useEffect(() => {
    if (!window.desktop) {
      return undefined
    }
    const unsubscribe = window.desktop.onChatCommand((command: ChatCommand) => {
      if (command.type === 'focus' && 'terminalId' in command) {
        setActiveId(command.terminalId)
      }
    })
    void window.desktop.chatRendererReady().catch((error: unknown) => {
      logger.error({ err: error }, 'failed to signal chat renderer readiness')
    })
    return unsubscribe
  }, [])

  // Clicking a live chat asks the server to switch to its worktree and focus the
  // chat window. `terminalId` is stamped by the server, so a chat is openable
  // exactly when it is set.
  const openLiveChat = useCallback(async (chat: Chat): Promise<void> => {
    if (!chat.terminalId || !chat.worktreeId) {
      return
    }
    setActiveId(chat.terminalId)
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

  const startTerminal = async (body: {
    providerId?: string
    resumeSessionId?: string
    title?: string
  }): Promise<void> => {
    if (!worktreeId) {
      return
    }
    const { data, error } = await createTerminal({
      body: { worktreeId, ...body },
    })
    if (error || !data) {
      logger.error({ err: error }, 'failed to start chat terminal')
      return
    }
    setActiveId(data.terminalId)
  }

  const openSession = (session: ChatSession): void => {
    void startTerminal({
      providerId: session.providerId,
      resumeSessionId: session.sessionId,
      title: session.title,
    })
  }

  // The tab strip and panes only show the current worktree's terminals.
  const worktreeTerminals = terminals.filter(
    (terminal) => terminal.worktreeId === worktreeId,
  )

  const liveChatCount = chats.filter(
    (chat) => chat.status !== CHAT_STATUS.dormant,
  ).length

  // Derive the shown terminal from the list so removing the active tab (e.g. on
  // exit) transparently falls back to another one without juggling `activeId`.
  const activeTerminalId = worktreeTerminals.some(
    (terminal) => terminal.terminalId === activeId,
  )
    ? activeId
    : (worktreeTerminals[0]?.terminalId ?? null)

  const headerTitle = worktree ? (
    <>
      Chat ·{' '}
      <Text style={{ color: worktreeColor(worktreeName(worktree)) }}>
        {worktreeName(worktree)}
      </Text>
    </>
  ) : (
    title
  )

  return (
    <VBox gap="0" height="100vh">
      <Titlebar title={headerTitle} />
      <HBox gap="0" align="stretch" justify="start" flexGrow="1" minHeight="0">
        <VBox
          gap="0"
          width="260px"
          flexShrink="0"
          minHeight="0"
          style={{ borderRight: '1px solid var(--gray-4)' }}
        >
          <VBox gap="2" p="3">
            <SegmentedControl.Root
              value={newChatProviderId}
              onValueChange={(value) =>
                setNewChatProviderId(parseChatProviderId(value))
              }
              disabled={!worktreeId}
            >
              {CHAT_PROVIDERS.map((provider) => (
                <SegmentedControl.Item key={provider.id} value={provider.id}>
                  {provider.label}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
            <Button
              size="2"
              variant="solid"
              onClick={() =>
                void startTerminal({ providerId: newChatProviderId })
              }
              disabled={!worktreeId}
              style={{ width: '100%' }}
            >
              New {chatProviderLabel(newChatProviderId)} chat
            </Button>
          </VBox>
          <Tabs.Root defaultValue="live" className={styles.tabs}>
            <Tabs.List className={styles.tabsList}>
              <Tabs.Trigger value="live">Live</Tabs.Trigger>
              <Tabs.Trigger value="historical">Historical</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="live" className={styles.tabContent}>
              {liveChatCount === 0 ? (
                <Box p="3">
                  <Text size="1" color="gray">
                    No live chats.
                  </Text>
                </Box>
              ) : (
                <VBox p="2" flexGrow="1" minHeight="0">
                  <LiveChats
                    chats={chats}
                    className={styles.liveChats}
                    onSelect={(chat) => void openLiveChat(chat)}
                    isChatDisabled={(chat) => !chat.terminalId}
                    resolveWorktreeName={resolveWorktreeName}
                  />
                </VBox>
              )}
            </Tabs.Content>
            <Tabs.Content value="historical" className={styles.tabContent}>
              <ScrollArea
                type="auto"
                scrollbars="vertical"
                className={`${styles.scroll} scroll-area-fill`}
              >
                <VBox gap="1" p="2">
                  {sessions.length === 0 ? (
                    <Box p="2">
                      <Text size="1" color="gray">
                        {worktreeId
                          ? 'No past chats in this worktree.'
                          : 'No worktree selected.'}
                      </Text>
                    </Box>
                  ) : (
                    sessions.map((session) => (
                      <SessionRow
                        key={`${session.providerId}:${session.sessionId}`}
                        session={session}
                        onClick={() => openSession(session)}
                      />
                    ))
                  )}
                </VBox>
              </ScrollArea>
            </Tabs.Content>
          </Tabs.Root>
        </VBox>

        <VBox gap="0" flexGrow="1" minWidth="0" minHeight="0">
          {worktreeTerminals.length > 0 && (
            <HBox
              gap="1"
              justify="start"
              px="2"
              py="1"
              style={{
                borderBottom: '1px solid var(--gray-4)',
                overflowX: 'auto',
              }}
            >
              {worktreeTerminals.map((terminal) => (
                <Button
                  key={terminal.terminalId}
                  size="1"
                  variant={
                    terminal.terminalId === activeTerminalId ? 'solid' : 'soft'
                  }
                  onClick={() => {
                    setActiveId(terminal.terminalId)
                  }}
                >
                  {terminalLabel(terminal)}
                </Button>
              ))}
            </HBox>
          )}
          <Box position="relative" flexGrow="1" minHeight="0" p="2">
            {worktreeTerminals.length === 0 ? (
              <VBox align="center" justify="center" height="100%" gap="2">
                <Text size="2" color="gray">
                  {worktreeId
                    ? 'Start a new chat or resume one from the sidebar.'
                    : 'Open the chat app from a worktree to begin.'}
                </Text>
              </VBox>
            ) : (
              worktreeTerminals.map((terminal) => {
                const isActive = terminal.terminalId === activeTerminalId
                // Hide inactive panes with `visibility`, not `display`, so they
                // keep their full size. A `display: none` pane collapses to 0×0,
                // which would make the terminal refit to ~1 column and corrupt
                // the CLI's layout when shown again.
                return (
                  <div
                    key={terminal.terminalId}
                    style={{
                      position: 'absolute',
                      inset: 'var(--space-2)',
                      visibility: isActive ? 'visible' : 'hidden',
                      zIndex: isActive ? 1 : 0,
                    }}
                  >
                    <Terminal
                      terminalId={terminal.terminalId}
                      active={isActive}
                      onExit={() => {
                        if (activeTerminalId === terminal.terminalId) {
                          setActiveId(null)
                        }
                      }}
                    />
                  </div>
                )
              })
            )}
          </Box>
        </VBox>
      </HBox>
    </VBox>
  )
}

function SessionRow({
  session,
  onClick,
}: {
  session: ChatSession
  onClick: () => void
}): React.JSX.Element {
  return (
    <Card asChild className={styles.sessionRow}>
      <button
        type="button"
        onClick={onClick}
        style={{ cursor: 'pointer', textAlign: 'left', width: '100%' }}
      >
        <VBox gap="1" align="start">
          <Text size="2" weight="medium" truncate style={{ width: '100%' }}>
            {session.title || 'Untitled chat'}
          </Text>
          <HBox gap="2" justify="start">
            <Code size="1" variant="ghost" color="gray">
              {session.providerId}
            </Code>
            <Text size="1" color="gray">
              {formatTimestamp(session.updatedAt)}
            </Text>
          </HBox>
        </VBox>
      </button>
    </Card>
  )
}

function terminalLabel(terminal: TerminalDescriptor): string {
  if (terminal.title) {
    return terminal.title
  }
  if (terminal.sessionId) {
    return `${terminal.providerId} · ${terminal.sessionId.slice(0, 8)}`
  }
  return `New ${terminal.providerId} chat`
}
