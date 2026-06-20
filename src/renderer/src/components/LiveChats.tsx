import { Badge, Card, ScrollArea, Skeleton, Text } from '@radix-ui/themes'
import {
  CHAT_STATUS,
  chatProviderLabel,
  parseChatProviderId,
  type ChatStatus,
} from '../../../api/server/chats'
import { worktreeColor } from '../controller/worktreeLabels'
import { formatShortAge } from '../format'
import type { Chat } from '../hooks/useChatStream'
import { Grid, HBox, VBox } from './Box'
import styles from './LiveChats.module.css'
import { StatusIndicator, type StatusIndicatorState } from './StatusIndicator'

const CHAT_STATUS_INDICATOR: Record<
  ChatStatus,
  { state: StatusIndicatorState; label: string }
> = {
  [CHAT_STATUS.busy]: { state: 'busy', label: 'Working' },
  [CHAT_STATUS.idle]: { state: 'ok', label: 'Waiting for you' },
  [CHAT_STATUS.dormant]: { state: 'neutral', label: 'Ended' },
}

/**
 * The live chats running across agentic coding systems. Dormant (ended) chats
 * are filtered out — only active conversations are surfaced here.
 */
export function LiveChats({
  chats,
  className,
  onSelect,
  isChatDisabled,
  resolveWorktreeName,
}: {
  chats: Chat[]
  /** Lets the consumer size the card in its layout (e.g. grow to fill space). */
  className?: string
  /** Invoked when a chat row is activated; makes the rows clickable buttons. */
  onSelect?: (chat: Chat) => void
  /** Disables a row's button, e.g. when the chat has no attachable terminal. */
  isChatDisabled?: (chat: Chat) => boolean
  /** Resolves a chat's worktree id to a display name, shown as a row badge. */
  resolveWorktreeName?: (worktreeId: string | undefined) => string | undefined
}): React.JSX.Element | null {
  const live = chats.filter((chat) => chat.status !== CHAT_STATUS.dormant)
  if (live.length === 0) {
    return null
  }

  return (
    <Card className={className ? `${styles.card} ${className}` : styles.card}>
      <ScrollArea
        type="auto"
        scrollbars="vertical"
        className={`${styles.scroll} scroll-area-fill`}
      >
        <VBox gap="0">
          {live.map((chat) => (
            <ChatRow
              key={`${chat.providerId}:${chat.chatId}`}
              chat={chat}
              onSelect={onSelect}
              disabled={isChatDisabled?.(chat) ?? false}
              worktreeName={resolveWorktreeName?.(chat.worktreeId)}
            />
          ))}
        </VBox>
      </ScrollArea>
    </Card>
  )
}

function ChatRow({
  chat,
  onSelect,
  disabled,
  worktreeName,
}: {
  chat: Chat
  onSelect?: (chat: Chat) => void
  disabled: boolean
  worktreeName?: string
}): React.JSX.Element {
  const secondary = chat.description || undefined

  return (
    <button
      type="button"
      className={styles.row}
      disabled={disabled}
      onClick={onSelect ? () => onSelect(chat) : undefined}
    >
      <Grid
        columns="16px minmax(0, 1fr)"
        gapX="2"
        gapY="1"
        align="center"
        p="2"
      >
        <HBox gridColumn="1" gridRow="1" justify="center">
          <ChatStatusDot status={chat.status} />
        </HBox>
        <HBox gridColumn="2" minWidth="0">
          {chat.title ? (
            <Text size="2" weight="medium" truncate style={{ minWidth: 0 }}>
              {chat.title}
            </Text>
          ) : (
            <Skeleton>
              <Text size="2">Loading</Text>
            </Skeleton>
          )}
          <Text size="1" color="gray">
            {formatShortAge(chat.updatedAt)}
          </Text>
        </HBox>
        <HBox gridColumn="2" minWidth="0">
          {secondary ? (
            <Text size="1" color="gray" truncate style={{ minWidth: 0 }}>
              {secondary}
            </Text>
          ) : (
            <Skeleton>
              <Text size="1">Loading</Text>
            </Skeleton>
          )}
        </HBox>
        <HBox gridColumn="2" minWidth="0" justify="start">
          {worktreeName ? (
            <Text size="1" style={{ color: worktreeColor(worktreeName) }}>
              {worktreeName}
            </Text>
          ) : (
            <></>
          )}
          <Badge size="1" variant="soft" radius="full" color="gray">
            {chatProviderLabel(parseChatProviderId(chat.providerId))}
          </Badge>
        </HBox>
      </Grid>
    </button>
  )
}

function ChatStatusDot({ status }: { status: ChatStatus }): React.JSX.Element {
  const { state, label } = CHAT_STATUS_INDICATOR[status]
  return <StatusIndicator state={state} label={label} />
}
