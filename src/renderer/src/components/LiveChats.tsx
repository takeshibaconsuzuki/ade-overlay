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
}: {
  chats: Chat[]
  /** Lets the consumer size the card in its layout (e.g. grow to fill space). */
  className?: string
}): React.JSX.Element | null {
  const live = chats.filter((chat) => chat.status !== CHAT_STATUS.dormant)
  if (live.length === 0) {
    return null
  }

  return (
    <Card className={className ? `${styles.card} ${className}` : styles.card}>
      <ScrollArea type="auto" scrollbars="vertical" className={styles.scroll}>
        <VBox gap="0">
          {live.map((chat) => (
            <ChatRow key={chat.chatId} chat={chat} />
          ))}
        </VBox>
      </ScrollArea>
    </Card>
  )
}

function ChatRow({ chat }: { chat: Chat }): React.JSX.Element {
  // The title is the chat's identity line; the description (latest prompt) is
  // secondary. Show it only when it adds something over the title.
  const secondary =
    chat.description && chat.description !== chat.title
      ? chat.description
      : undefined

  return (
    <HBox p="2">
      <HBox width="32px" justify="center">
        <ChatStatusDot status={chat.status} />
      </HBox>
      <VBox className={styles.text} flexGrow="1" gap="1">
        {chat.title ? (
          <Text size="2" weight="medium" truncate>
            {chat.title}
          </Text>
        ) : (
          // Title not resolved yet — show a skeleton until it arrives.
          <Skeleton>
            <Text size="2">Loading</Text>
          </Skeleton>
        )}
        {secondary ? (
          <Text size="1" color="gray" truncate>
            {secondary}
          </Text>
        ) : null}
      </VBox>
    </HBox>
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
