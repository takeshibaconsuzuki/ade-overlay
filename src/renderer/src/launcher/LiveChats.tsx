import {
  Box,
  Card,
  Flex,
  ScrollArea,
  Skeleton,
  Spinner,
  Text,
  Tooltip,
} from '@radix-ui/themes'
import { CHAT_STATUS, type ChatStatus } from '../../../api/server/chats'
import { type Chat } from './chats'

const STATUS_DOT: Record<ChatStatus, { color: string; label: string }> = {
  [CHAT_STATUS.busy]: { color: 'var(--amber-9)', label: 'Working' },
  [CHAT_STATUS.idle]: { color: 'var(--grass-9)', label: 'Waiting for you' },
  [CHAT_STATUS.dormant]: { color: 'var(--gray-7)', label: 'Ended' },
}

/**
 * The live chats running across agentic coding systems. Dormant (ended) chats
 * are filtered out — only active conversations are surfaced here.
 */
export function LiveChats({
  chats,
}: {
  chats: Chat[]
}): React.JSX.Element | null {
  const live = chats.filter((chat) => chat.status !== CHAT_STATUS.dormant)
  if (live.length === 0) {
    return null
  }

  return (
    // Padding lives on the Card (outside the scroll clip) so the gap around
    // rows stays uniform on every side. The list fills the launcher's remaining
    // height and scrolls when there are more chats than fit.
    <Card style={{ flexGrow: 1, minHeight: 0, padding: 'var(--space-2)' }}>
      <ScrollArea
        type="auto"
        scrollbars="vertical"
        className="scroll-clip-x"
        style={{ height: '100%' }}
      >
        <Box className="chat-list">
          {live.map((chat) => (
            <ChatRow key={chat.chatId} chat={chat} />
          ))}
        </Box>
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
    <Box className="chat-row">
      {/* Leading status column. Its width is shared across all rows via the
          list's subgrid, so a spinner and a dot leave the text aligned. */}
      <Flex align="center" justify="center">
        <ChatStatusDot status={chat.status} />
      </Flex>
      <Flex direction="column" minWidth="0">
        {chat.title ? (
          <Text size="2" weight="medium" truncate>
            {chat.title}
          </Text>
        ) : (
          // Title not resolved yet — show a skeleton until it arrives.
          <Skeleton width="12rem">
            <Text size="2" weight="medium">
              Loading
            </Text>
          </Skeleton>
        )}
        {secondary ? (
          <Text size="1" color="gray" truncate>
            {secondary}
          </Text>
        ) : null}
      </Flex>
    </Box>
  )
}

function ChatStatusDot({ status }: { status: ChatStatus }): React.JSX.Element {
  const { color, label } = STATUS_DOT[status]
  if (status === CHAT_STATUS.busy) {
    return (
      <Tooltip content={label}>
        <Spinner />
      </Tooltip>
    )
  }

  return (
    <Tooltip content={label}>
      <Box
        aria-label={label}
        width="8px"
        height="8px"
        flexShrink="0"
        style={{ borderRadius: '50%', backgroundColor: color }}
      />
    </Tooltip>
  )
}
