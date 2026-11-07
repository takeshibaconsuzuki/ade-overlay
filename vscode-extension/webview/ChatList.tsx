import type { ReactNode } from 'react'
import { Box, Flex, Skeleton, Spinner, Text } from '@radix-ui/themes'
import type { Chat } from '../../src/shared/api'

function Field({ value, name }: { value: string | undefined; name: string }) {
  return (
    <Text
      as="span"
      size="2"
      weight={name === 'title' ? 'medium' : 'regular'}
      color={name === 'title' ? undefined : 'gray'}
      className={`chat-field chat-${name}`}
      title={value}
    >
      {value === undefined ? (
        <span aria-label={`Loading ${name}`} role="status">
          <Skeleton className="chat-skeleton" />
        </span>
      ) : (
        value
      )}
    </Text>
  )
}

export interface ChatRowContent {
  title: string
  worktree: string
  // Undefined until a description is available.
  description: string | undefined
  // Present for live chats only.
  status: Chat['status'] | undefined
  tooltip: string
}

// Undefined content renders a disabled loading row.
export function ChatRow({
  content,
  current = false,
  onOpen,
}: {
  content: ChatRowContent | undefined
  current?: boolean
  onOpen: () => void
}) {
  return (
    <li className="chat">
      <Flex asChild direction="column" gap="1" px="4" py="3">
        <button
          type="button"
          className="chat-open"
          aria-current={content && current ? true : undefined}
          disabled={!content}
          onClick={onOpen}
          title={content?.tooltip}
        >
          <Flex asChild align="center" gap="2">
            <span>
              <span
                className="chat-status"
                role={content?.status ? 'img' : undefined}
                aria-label={content?.status}
                title={content?.status}
              >
                {content?.status === 'idle' ? (
                  <span className="chat-idle" />
                ) : content?.status === 'working' ? (
                  <Spinner size="1" aria-hidden="true" />
                ) : null}
              </span>
              <Field name="title" value={content?.title} />
            </span>
          </Flex>
          <Field name="worktree" value={content?.worktree} />
          <Field name="description" value={content?.description} />
        </button>
      </Flex>
    </li>
  )
}

export function loadingRows(): ReactNode[] {
  return Array.from({ length: 3 }, (_, index) => (
    <ChatRow key={index} content={undefined} onOpen={() => {}} />
  ))
}

export function ChatNotice({ children }: { children: ReactNode }) {
  return (
    <Box p="4">
      <Text as="p" size="2" color="gray">
        {children}
      </Text>
    </Box>
  )
}

export function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

export function ChatList({
  chats,
  selectedChatId,
  onOpenChat,
}: {
  chats: Record<string, Chat> | undefined
  selectedChatId: string | undefined
  onOpenChat: (id: string) => void
}) {
  const entries =
    chats === undefined
      ? undefined
      : Object.entries(chats).sort(
          ([aId, a], [bId, b]) =>
            (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) ||
            aId.localeCompare(bId),
        )
  return (
    <main aria-label="Live chats" aria-busy={chats === undefined}>
      {entries?.length === 0 ? (
        <ChatNotice>No live chats.</ChatNotice>
      ) : (
        <ul className="chats">
          {entries?.map(([id, chat]) => (
            <ChatRow
              key={id}
              content={{
                title: chat.title,
                worktree: basename(chat.worktreePath),
                description: chat.description,
                status: chat.status,
                tooltip: `Open chat in ${chat.worktreePath}`,
              }}
              current={id === selectedChatId}
              onOpen={() => onOpenChat(id)}
            />
          )) ?? loadingRows()}
        </ul>
      )}
    </main>
  )
}
