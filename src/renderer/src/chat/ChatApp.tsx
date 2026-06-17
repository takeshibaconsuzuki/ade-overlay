import {
  Box,
  Button,
  Card,
  Code,
  ScrollArea,
  Tabs,
  Text,
} from '@radix-ui/themes'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CHAT_COMMAND_STREAM_PATH,
  CHAT_STATUS,
} from '../../../api/server/chats'
import { SERVER_ORIGIN } from '../../../api/server/config'
import {
  createChatTerminal,
  listChatHistory,
  listChatTerminals,
  openChat,
  openWorktree,
} from '../../../api/server/generated'
import { HBox, VBox } from '../components/Box'
import { LiveChats } from '../components/LiveChats'
import { Titlebar } from '../components/Titlebar'
import { worktreeName } from '../controller/worktreeLabels'
import { useWorktreeStream } from '../controller/worktrees'
import { formatTimestamp } from '../format'
import { useChatStream, type Chat } from '../hooks/useChatStream'
import { useCurrentWorktreeId } from '../hooks/useCurrentWorktreeId'
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

type ChatTerminal = {
  terminalId: string
  worktreeId: string
  providerId: string
  sessionId?: string
  title?: string
  status: 'running' | 'exited'
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

  const [sessions, setSessions] = useState<ChatSession[]>([])
  // Every live terminal across worktrees: the tab strip filters to the current
  // worktree, while the live-chat list needs the full set to resolve a chat in
  // another worktree to its terminal.
  const [terminals, setTerminals] = useState<ChatTerminal[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // A live chat targeted from another window (via the `show` command) whose
  // terminal isn't loaded yet (a cross-worktree click): held until the
  // accompanying worktree switch reloads the terminals, then selected by the
  // load effect below. Same-worktree targets resolve instantly from memory (see
  // the command listener) and never set this.
  const [pendingChatTarget, setPendingChatTarget] = useState<{
    providerId: string
    chatId: string
  } | null>(null)

  // Latest terminals, readable from the command listener (registered once) so it
  // can select an already-loaded terminal without waiting on a refetch.
  const terminalsRef = useRef(terminals)
  useEffect(() => {
    terminalsRef.current = terminals
  }, [terminals])

  // Terminals are cheap (the server lists them from memory) and drive the Live
  // tab + panes, so they load on their own — never blocked behind the slow,
  // git-backed history fetch below.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const live = await listChatTerminals()
      if (cancelled) {
        return
      }
      const openTerminals = live.data?.terminals ?? []
      setTerminals(openTerminals)
      setActiveId(
        (current) =>
          current ??
          openTerminals.find((terminal) => terminal.worktreeId === worktreeId)
            ?.terminalId ??
          null,
      )
      // Select a chat targeted from another window once its terminal is loaded.
      if (pendingChatTarget) {
        const terminal = openTerminals.find(
          (t) =>
            t.providerId === pendingChatTarget.providerId &&
            t.sessionId === pendingChatTarget.chatId,
        )
        if (terminal) {
          setActiveId(terminal.terminalId)
          setPendingChatTarget(null)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [worktreeId, pendingChatTarget])

  // Historical sessions are read from disk (git), so they load separately and
  // only feed the Historical tab; a slow read never delays terminal display.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (!worktreeId) {
        setSessions([])
        return
      }
      const history = await listChatHistory({ query: { worktreeId } })
      if (!cancelled) {
        setSessions(history.data?.sessions ?? [])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [worktreeId])

  // Listen for `show` commands carrying a target chat (a live chat clicked from
  // another window, e.g. the launcher). If its terminal is already loaded,
  // select it immediately; otherwise stash it for the load effect to pick up
  // once the accompanying worktree switch brings its terminals in.
  useEffect(() => {
    const source = new EventSource(
      `${SERVER_ORIGIN}${CHAT_COMMAND_STREAM_PATH}`,
    )
    source.addEventListener('show', (event) => {
      try {
        const data = JSON.parse(event.data) as {
          providerId?: string
          chatId?: string
        }
        if (!data.providerId || !data.chatId) {
          return
        }
        const terminal = terminalsRef.current.find(
          (t) =>
            t.providerId === data.providerId && t.sessionId === data.chatId,
        )
        if (terminal) {
          setActiveId(terminal.terminalId)
        } else {
          setPendingChatTarget({
            providerId: data.providerId,
            chatId: data.chatId,
          })
        }
      } catch (error) {
        logger.error({ err: error }, 'failed to parse chat command')
      }
    })
    return () => source.close()
  }, [])

  // Clicking a live chat brings its terminal forward: switch to its worktree,
  // focus the chat window, and select its tab. `terminalId` is stamped by the
  // server, so a chat is openable exactly when it's set (and the chat's worktree
  // is the terminal's worktree). The tab selection survives the worktree change
  // because the terminals effect keeps a set `activeId`.
  const openLiveChat = useCallback(
    async (chat: Chat): Promise<void> => {
      if (!chat.terminalId) {
        return
      }
      setActiveId(chat.terminalId)
      if (chat.worktreeId && chat.worktreeId !== worktreeId) {
        const { error } = await openWorktree({
          body: { worktreeId: chat.worktreeId },
        })
        if (error) {
          logger.error(
            { err: error, worktreeId: chat.worktreeId },
            'failed to switch worktree for live chat',
          )
          return
        }
      }
      // Focus the chat window last so it ends up in front of the editor that
      // the worktree switch may have brought forward. Pass the target so the
      // selection also survives the worktree reload via the pending-target path.
      await openChat({
        body: { providerId: chat.providerId, chatId: chat.chatId },
      })
    },
    [worktreeId],
  )

  const startTerminal = async (body: {
    providerId?: string
    resumeSessionId?: string
    title?: string
  }): Promise<void> => {
    if (!worktreeId) {
      return
    }
    const { data, error } = await createChatTerminal({
      body: { worktreeId, ...body },
    })
    if (error || !data) {
      logger.error({ err: error }, 'failed to start chat terminal')
      return
    }
    setTerminals((current) => [...current, data])
    setActiveId(data.terminalId)
  }

  // Resuming a session that already has an open terminal should focus it rather
  // than spawn a duplicate; otherwise start a fresh resumed terminal.
  const openSession = (session: ChatSession): void => {
    const existing = terminals.find(
      (terminal) =>
        terminal.providerId === session.providerId &&
        terminal.sessionId === session.sessionId,
    )
    if (existing) {
      setActiveId(existing.terminalId)
      return
    }
    void startTerminal({
      providerId: session.providerId,
      resumeSessionId: session.sessionId,
      title: session.title,
    })
  }

  const removeTerminal = (terminalId: string): void => {
    setTerminals((current) =>
      current.filter((terminal) => terminal.terminalId !== terminalId),
    )
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

  const headerTitle = worktree ? `Chat · ${worktreeName(worktree)}` : title

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
          <Box p="3">
            <Button
              size="2"
              variant="solid"
              onClick={() => void startTerminal({})}
              disabled={!worktreeId}
              style={{ width: '100%' }}
            >
              New chat
            </Button>
          </Box>
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
                  onClick={() => setActiveId(terminal.terminalId)}
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
                      onExit={() => removeTerminal(terminal.terminalId)}
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

function terminalLabel(terminal: ChatTerminal): string {
  if (terminal.title) {
    return terminal.title
  }
  if (terminal.sessionId) {
    return `${terminal.providerId} · ${terminal.sessionId.slice(0, 8)}`
  }
  return `New ${terminal.providerId} chat`
}
