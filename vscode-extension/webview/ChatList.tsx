import { Box, Flex, Skeleton, Text } from '@radix-ui/themes'
import type { Chat } from '../../src/shared/api'

function Field({ value, name }: { value: string | undefined; name: string }) {
  return (
    <Text
      as="div"
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
}: {
  chats: Record<string, Chat> | undefined
}) {
  const entries =
    chats === undefined
      ? undefined
      : Object.entries(chats).sort(
          ([aId, a], [bId, b]) => b.mtime - a.mtime || aId.localeCompare(bId),
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
            <Flex asChild direction="column" gap="1" px="4" py="3" key={id}>
              <li className="chat">
                <Field name="title" value={chat?.title} />
                <Field
                  name="worktree"
                  value={chat?.worktreePath
                    .replace(/[\\/]+$/, '')
                    .split(/[\\/]/)
                    .pop()}
                />
                <Field name="description" value={chat?.description} />
              </li>
            </Flex>
          ))}
        </ul>
      )}
    </main>
  )
}
