import type { Chat } from '../../src/shared/api'

function Field({ value, name }: { value: string | undefined; name: string }) {
  return (
    <div className={`chat-${name}`}>
      {value === undefined ? (
        <span className="skeleton" aria-label={`Loading ${name}`} />
      ) : (
        value
      )}
    </div>
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
        <p className="empty">No live chats.</p>
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
          ))}
        </ul>
      )}
    </main>
  )
}
