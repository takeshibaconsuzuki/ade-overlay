import {
  Badge,
  Box,
  Button,
  Card,
  DropdownMenu,
  IconButton,
  ScrollArea,
  Tabs,
  Text,
} from '@radix-ui/themes'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Grid, HBox, VBox } from '../components/Box'
import { LiveChats } from '../components/LiveChats'
import liveChatStyles from '../components/LiveChats.module.css'
import { Titlebar } from '../components/Titlebar'
import { worktreeColor, worktreeName } from '../controller/worktreeLabels'
import { useWorktreeStream } from '../controller/worktrees'
import { formatShortAge } from '../format'
import { useChatStream, type Chat } from '../hooks/useChatStream'
import { useCurrentWorktreeId } from '../hooks/useCurrentWorktreeId'
import {
  useTerminalStream,
  type TerminalDescriptor,
} from '../hooks/useTerminalStream'
import { logger } from '../logger'
import styles from './ChatApp.module.css'
import { Terminal } from './Terminal'

/**
 * The chat app: a sidebar of the current worktree's chats (live and historical)
 * and a tabbed area of live terminals. Clicking a historical chat resumes it in
 * a new terminal; "New chat" starts a fresh one. Terminals live in the server,
 * so reopening this window re-lists and re-attaches them.
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

  const [historyChats, setHistoryChats] = useState<Chat[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newChatProviderId, setNewChatProviderId] = useState<ChatProviderId>(
    DEFAULT_CHAT_PROVIDER,
  )

  // Historical chats are read from disk, so they load separately from the live
  // stream and only on mount / worktree change; a slow read never delays
  // terminal display. A chat that ends later needs no re-read: the live registry
  // retains dormant entries, so the overlay below surfaces it reactively.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (!worktreeId) {
        setHistoryChats([])
        return
      }
      const history = await historicalChats({ query: { worktreeId } })
      if (!cancelled) {
        setHistoryChats(history.data?.chats ?? [])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [worktreeId])

  // The Historical tab is the union of on-disk chats and the live stream's
  // dormant (ended) chats, overlaid by (providerId, chatId) so the live entry
  // wins. A currently-running chat carries a non-dormant status and so drops out
  // of this list — it shows only in the Live tab. Most-recent first.
  const historyView = useMemo(() => {
    const byKey = new Map<string, Chat>()
    for (const chat of historyChats) {
      byKey.set(`${chat.providerId}:${chat.chatId}`, chat)
    }
    for (const chat of chats) {
      if (chat.worktreeId === worktreeId) {
        byKey.set(`${chat.providerId}:${chat.chatId}`, chat)
      }
    }
    return [...byKey.values()]
      .filter((chat) => chat.status === CHAT_STATUS.dormant)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }, [historyChats, chats, worktreeId])

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
    resumeChatId?: string
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

  // Launch a chat with the given provider and remember it as the default for the
  // split button's primary action.
  const launchChat = async (providerId: ChatProviderId): Promise<void> => {
    setNewChatProviderId(providerId)
    await startTerminal({ providerId })
  }

  const openHistoricalChat = (chat: Chat): void => {
    void startTerminal({
      providerId: chat.providerId,
      resumeChatId: chat.chatId,
      title: chat.title,
    })
  }

  // The tab strip and panes only show the current worktree's terminals.
  const worktreeTerminals = terminals.filter(
    (terminal) => terminal.worktreeId === worktreeId,
  )

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
            <HBox gap="0" align="stretch">
              <Button
                size="2"
                variant="solid"
                onClick={() => void launchChat(newChatProviderId)}
                disabled={!worktreeId}
                style={{
                  flexGrow: 1,
                  borderTopRightRadius: 0,
                  borderBottomRightRadius: 0,
                }}
              >
                New {chatProviderLabel(newChatProviderId)} chat
              </Button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <IconButton
                    size="2"
                    variant="solid"
                    aria-label="Choose chat provider"
                    disabled={!worktreeId}
                    style={{
                      borderTopLeftRadius: 0,
                      borderBottomLeftRadius: 0,
                      boxShadow: 'inset 1px 0 0 0 var(--gray-a6)',
                    }}
                  >
                    <ChevronDown size={16} />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  {CHAT_PROVIDERS.map((provider) => (
                    <DropdownMenu.Item
                      key={provider.id}
                      onSelect={() => void launchChat(provider.id)}
                    >
                      New {provider.label} chat
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </HBox>
          </VBox>
          <Tabs.Root defaultValue="live" className={styles.tabs}>
            <Tabs.List className={styles.tabsList}>
              <Tabs.Trigger value="live">Live</Tabs.Trigger>
              <Tabs.Trigger value="historical">Historical</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="live" className={styles.tabContent}>
              <VBox p="2" flexGrow="1" minHeight="0">
                <LiveChats
                  chats={chats}
                  className={styles.liveChats}
                  onSelect={(chat) => void openLiveChat(chat)}
                  isChatDisabled={(chat) => !chat.terminalId}
                  resolveWorktreeName={resolveWorktreeName}
                />
              </VBox>
            </Tabs.Content>
            <Tabs.Content value="historical" className={styles.tabContent}>
              <VBox p="2" flexGrow="1" minHeight="0">
                <Card className={`${liveChatStyles.card} ${styles.liveChats}`}>
                  {historyView.length === 0 ? (
                    <HBox p="2" justify="center">
                      <Text size="1" color="gray">
                        {worktreeId
                          ? 'No past chats in this worktree.'
                          : 'No worktree selected.'}
                      </Text>
                    </HBox>
                  ) : (
                    <ScrollArea
                      type="auto"
                      scrollbars="vertical"
                      className={`${liveChatStyles.scroll} scroll-area-fill`}
                    >
                      <VBox gap="0">
                        {historyView.map((chat) => (
                          <HistoricalChatRow
                            key={`${chat.providerId}:${chat.chatId}`}
                            chat={chat}
                            onClick={() => openHistoricalChat(chat)}
                          />
                        ))}
                      </VBox>
                    </ScrollArea>
                  )}
                </Card>
              </VBox>
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

function HistoricalChatRow({
  chat,
  onClick,
}: {
  chat: Chat
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className={liveChatStyles.row} onClick={onClick}>
      <Grid columns="minmax(0, 1fr)" gapX="2" gapY="1" align="center" p="2">
        <HBox minWidth="0">
          <Text size="2" weight="medium" truncate style={{ minWidth: 0 }}>
            {chat.title || 'Untitled chat'}
          </Text>
          <Text size="1" color="gray">
            {formatShortAge(chat.updatedAt)}
          </Text>
        </HBox>
        {chat.description ? (
          <HBox minWidth="0">
            <Text size="1" color="gray" truncate style={{ minWidth: 0 }}>
              {chat.description}
            </Text>
          </HBox>
        ) : null}
        <HBox minWidth="0" justify="start">
          <Badge size="1" variant="soft" radius="full" color="gray">
            {chatProviderLabel(parseChatProviderId(chat.providerId))}
          </Badge>
        </HBox>
      </Grid>
    </button>
  )
}

function terminalLabel(terminal: TerminalDescriptor): string {
  if (terminal.title) {
    return terminal.title
  }
  return 'Chat'
}
