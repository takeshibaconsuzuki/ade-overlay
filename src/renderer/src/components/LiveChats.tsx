import {
  Box,
  Card,
  ScrollArea,
  Skeleton,
  Spinner,
  Text,
  Tooltip,
} from '@radix-ui/themes'
import { CHAT_STATUS, type ChatStatus } from '../../../api/server/chats'
import { worktreeColor } from '../controller/worktreeLabels'
import { formatShortAge } from '../format'
import type { Chat } from '../hooks/useChatStream'
import { HBox, VBox } from './Box'
import styles from './LiveChats.module.css'

const STATUS_DOT: Record<ChatStatus, { className: string; label: string }> = {
  [CHAT_STATUS.busy]: { className: styles.dotBusy, label: 'Working' },
  [CHAT_STATUS.idle]: { className: styles.dotIdle, label: 'Waiting for you' },
  [CHAT_STATUS.dormant]: { className: styles.dotDormant, label: 'Ended' },
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
      <HBox p="2">
        <HBox width="32px" flexShrink="0" justify="center">
          <ChatStatusDot status={chat.status} />
        </HBox>
        <VBox className={styles.text} flexGrow="1" gap="1">
          <HBox>
            {chat.title ? (
              <Text size="2" weight="medium" truncate style={{ minWidth: 0 }}>
                {chat.title}
              </Text>
            ) : (
              <Skeleton>
                <Text size="2">Loading</Text>
              </Skeleton>
            )}
          </HBox>
          <HBox>
            {worktreeName ? (
              <Text size="1" style={{ color: worktreeColor(worktreeName) }}>
                {worktreeName}
              </Text>
            ) : (
              <></>
            )}
            <Text size="1" color="gray">
              {formatShortAge(chat.updatedAt)}
            </Text>
          </HBox>
          <HBox>
            {secondary ? (
              <Text size="1" color="gray" truncate style={{ minWidth: 0 }}>
                {secondary}
              </Text>
            ) : null}
          </HBox>
        </VBox>
      </HBox>
    </button>
  )
}

function ChatStatusDot({ status }: { status: ChatStatus }): React.JSX.Element {
  const { className, label } = STATUS_DOT[status]
  if (status === CHAT_STATUS.busy) {
    return (
      <Tooltip content={label}>
        <Spinner />
      </Tooltip>
    )
  }

  return (
    <Tooltip content={label}>
      <Box aria-label={label} className={`${styles.dot} ${className}`} />
    </Tooltip>
  )
}
