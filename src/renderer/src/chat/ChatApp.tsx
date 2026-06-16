import { Box, Button, Card, Code, ScrollArea, Text } from '@radix-ui/themes'
import { useEffect, useState } from 'react'
import {
  createChatTerminal,
  listChatHistory,
  listChatTerminals,
} from '../../../api/server/generated'
import { HBox, VBox } from '../components/Box'
import { Titlebar } from '../components/Titlebar'
import { worktreeName } from '../controller/worktreeLabels'
import { useWorktreeStream } from '../controller/worktrees'
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

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [terminals, setTerminals] = useState<ChatTerminal[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (!worktreeId) {
        if (!cancelled) {
          setSessions([])
          setTerminals([])
          setActiveId(null)
        }
        return
      }
      const [history, live] = await Promise.all([
        listChatHistory({ query: { worktreeId } }),
        listChatTerminals({ query: { worktreeId } }),
      ])
      if (cancelled) {
        return
      }
      const openTerminals = live.data?.terminals ?? []
      setSessions(history.data?.sessions ?? [])
      setTerminals(openTerminals)
      setActiveId((current) => current ?? openTerminals[0]?.terminalId ?? null)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [worktreeId])

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

  // Derive the shown terminal from the list so removing the active tab (e.g. on
  // exit) transparently falls back to another one without juggling `activeId`.
  const activeTerminalId = terminals.some(
    (terminal) => terminal.terminalId === activeId,
  )
    ? activeId
    : (terminals[0]?.terminalId ?? null)

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
          <ScrollArea
            type="auto"
            scrollbars="vertical"
            className="scroll-area-fill"
          >
            <VBox gap="1" px="2" pb="2">
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
        </VBox>

        <VBox gap="0" flexGrow="1" minWidth="0" minHeight="0">
          {terminals.length > 0 && (
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
              {terminals.map((terminal) => (
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
            {terminals.length === 0 ? (
              <VBox align="center" justify="center" height="100%" gap="2">
                <Text size="2" color="gray">
                  {worktreeId
                    ? 'Start a new chat or resume one from the sidebar.'
                    : 'Open the chat app from a worktree to begin.'}
                </Text>
              </VBox>
            ) : (
              terminals.map((terminal) => {
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

function formatTimestamp(value: number): string {
  if (!value) {
    return ''
  }
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
