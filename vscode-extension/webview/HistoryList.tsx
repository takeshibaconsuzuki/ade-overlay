import type { Ref } from 'react'
import { MagnifyingGlassIcon } from '@radix-ui/react-icons'
import { Box, Spinner, TextField } from '@radix-ui/themes'
import type { Chat, ChatHistoryEntry } from '../../src/shared/api'
import type { HistoryMessage } from '../shared/api'
import { basename, ChatNotice, ChatRow, loadingRows } from './ChatList'

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

export function HistoryList({
  searchRef,
  query,
  onQueryChange,
  history,
  liveChats,
  onResume,
}: {
  searchRef: Ref<HTMLInputElement>
  query: string
  onQueryChange: (query: string) => void
  // Results for an earlier query remain until the current query's arrive.
  history: HistoryMessage | undefined
  liveChats: Record<string, Chat> | undefined
  onResume: (entry: ChatHistoryEntry) => void
}) {
  const results = history?.results
  return (
    <main aria-label="Chat history" aria-busy={results === undefined}>
      <Box px="4" pt="3" pb="1">
        <TextField.Root
          ref={searchRef}
          type="search"
          placeholder="Search chats"
          aria-label="Search chat history"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        >
          <TextField.Slot>
            <MagnifyingGlassIcon />
          </TextField.Slot>
          {results?.indexing ? (
            <TextField.Slot>
              <Spinner size="1" aria-label="Updating chat history" />
            </TextField.Slot>
          ) : null}
        </TextField.Root>
      </Box>
      {results?.chats.length === 0 ? (
        <ChatNotice>
          {results.indexing
            ? 'Updating chat history…'
            : history?.query.trim()
              ? 'No matching chats.'
              : 'No chats.'}
        </ChatNotice>
      ) : (
        <ul className="chats">
          {results?.chats.map((entry) => {
            const id = `${entry.providerId}:${entry.sessionId}`
            const live = liveChats?.[id]
            return (
              <ChatRow
                key={id}
                content={{
                  title: entry.title,
                  worktree: [
                    basename(entry.cwd),
                    dates.format(entry.modifiedAt),
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  description: entry.excerpt,
                  status: live?.status,
                  tooltip: live
                    ? `Open chat in ${live.worktreePath}`
                    : `Resume chat here (recorded in ${entry.cwd})`,
                }}
                onOpen={() => onResume(entry)}
              />
            )
          }) ?? loadingRows()}
        </ul>
      )}
    </main>
  )
}
