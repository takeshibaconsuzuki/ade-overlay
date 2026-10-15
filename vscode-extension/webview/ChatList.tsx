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

export function ChatList({
  chats,
  activeTerminalId,
  onOpenChat,
}: {
  chats: Record<string, Chat> | undefined
  activeTerminalId: string | undefined
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
        <Box p="4">
          <Text as="p" size="2" color="gray">
            No live chats.
          </Text>
        </Box>
      ) : (
        <ul className="chats">
          {(
            entries ??
            Array.from(
              { length: 3 },
              (_, index) => [String(index), undefined] as const,
            )
          ).map(([id, chat]) => (
            <li className="chat" key={id}>
              <Flex asChild direction="column" gap="1" px="4" py="3">
                <button
                  type="button"
                  className="chat-open"
                  aria-current={
                    chat?.terminalId !== undefined &&
                    chat.terminalId === activeTerminalId
                      ? true
                      : undefined
                  }
                  disabled={!chat}
                  onClick={() => onOpenChat(id)}
                  title={chat && `Open chat in ${chat.worktreePath}`}
                >
                  <Flex asChild align="center" gap="2">
                    <span>
                      <span
                        className="chat-status"
                        role={chat ? 'img' : undefined}
                        aria-label={chat?.status}
                        title={chat?.status}
                      >
                        {chat?.status === 'idle' ? (
                          <span className="chat-idle" />
                        ) : chat?.status === 'working' ? (
                          <Spinner size="1" aria-hidden="true" />
                        ) : null}
                      </span>
                      <Field name="title" value={chat?.title} />
                    </span>
                  </Flex>
                  <Field
                    name="worktree"
                    value={chat?.worktreePath
                      .replace(/[\\/]+$/, '')
                      .split(/[\\/]/)
                      .pop()}
                  />
                  <Field name="description" value={chat?.description} />
                </button>
              </Flex>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
