import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ChatHistory, ChatHistoryIndex } from '../src/server/chat-history'
import type { ChatMessage, ChatSession } from '../src/server/chat-provider'
import { LocalChatHistoryIndexer } from './fixtures/chat-history'
import { TestChatProvider } from './fixtures/chat-provider'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-history-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'index.sqlite')
  // Every session's working directory is inside it.
  const worktrees = [join(directory, 'worktrees')]
  const provider = new TestChatProvider()
  const session = (
    sessionId: string,
    modifiedAt: number,
    title = sessionId,
  ): ChatSession => ({
    sessionId,
    title,
    cwd: join(directory, 'worktrees', sessionId),
    modifiedAt,
  })
  const open = () => {
    const index = new ChatHistoryIndex(path)
    t.after(() => index.close())
    return index
  }
  return { directory, path, worktrees, provider, session, open }
}

test('updates read only sessions modified since their last read and replace their messages', async (t) => {
  const f = await fixture(t)
  f.provider.sessions = [f.session('one', 1), f.session('two', 1)]
  f.provider.messages.set('one', ['first prompt', 'first answer'])
  f.provider.messages.set('two', ['other prompt'])
  const reads = t.mock.method(f.provider, 'readMessages')
  const index = f.open()
  await index.update([f.provider])
  await index.update([f.provider])
  assert.deepEqual(
    reads.mock.calls.map((call) => call.arguments[0]),
    [['one', 'two']],
  )

  f.provider.messages.set('one', ['second prompt', 'second answer'])
  f.provider.sessions = [f.session('one', 2), f.session('two', 1)]
  await index.update([f.provider])
  assert.deepEqual(reads.mock.calls.at(-1)?.arguments[0], ['one'])
  assert.deepEqual(index.search(f.worktrees, 'first'), [])
  assert.deepEqual(
    index
      .search(f.worktrees, 'second')
      .map(({ sessionId, excerpt }) => [sessionId, excerpt]),
    [['one', 'second answer']],
  )

  // The index persists across connections.
  const reopened = f.open()
  await reopened.update([f.provider])
  assert.equal(reads.mock.callCount(), 2)
  assert.equal(reopened.search(f.worktrees, 'second').length, 1)
})

test('an interrupted read keeps previous messages and repeats only unfinished sessions', async (t) => {
  const f = await fixture(t)
  f.provider.sessions = [
    f.session('one', 1),
    f.session('two', 1),
    f.session('empty', 1),
  ]
  f.provider.messages.set('one', ['a1', 'a2'])
  f.provider.messages.set('two', ['b1', 'b2'])
  const index = f.open()
  await index.update([f.provider])
  let fail = true
  const reads = t.mock.method(
    f.provider,
    'readMessages',
    async function* (sessionIds: readonly string[]) {
      for (const sessionId of sessionIds)
        for (const text of f.provider.messages.get(sessionId) ?? []) {
          yield { sessionId, text } satisfies ChatMessage
          if (fail && text === 'b3') throw new Error('Read failed')
        }
    },
  )
  f.provider.sessions = [
    f.session('one', 2),
    f.session('two', 2),
    f.session('empty', 2),
  ]
  f.provider.messages.set('one', ['a3'])
  f.provider.messages.set('two', ['b3', 'b4'])
  await index.update([f.provider])
  assert.deepEqual(
    index
      .search(f.worktrees, '')
      .map(({ sessionId, excerpt }) => [sessionId, excerpt]),
    [
      ['one', 'a3'],
      ['two', 'b2'],
    ],
  )

  fail = false
  await index.update([f.provider])
  await index.update([f.provider])
  assert.deepEqual(
    reads.mock.calls.map((call) => call.arguments[0]),
    [
      ['one', 'two', 'empty'],
      ['two', 'empty'],
    ],
  )
  assert.deepEqual(
    index.search(f.worktrees, 'b').map(({ excerpt }) => excerpt),
    ['b4'],
  )
})

test('queries match every term in one message, ignoring case, and order chats by modification', async (t) => {
  const f = await fixture(t)
  const filler = 'word '.repeat(100)
  f.provider.sessions = [
    f.session('older', 1000, 'Older chat'),
    f.session('newer', 2000, 'Newer chat'),
  ]
  f.provider.messages.set('older', [
    'Add Snowflake semantic views',
    `${filler}\nThe   semantic\nviews load now. ${filler}`,
  ])
  f.provider.messages.set('newer', ['Rotate snowflake credentials', 'Done.'])
  const index = f.open()
  await index.update([f.provider])

  assert.deepEqual(index.search(f.worktrees, '  '), [
    {
      providerId: 'test',
      sessionId: 'newer',
      title: 'Newer chat',
      cwd: f.session('newer', 0).cwd,
      modifiedAt: 2000,
      excerpt: 'Done.',
    },
    {
      providerId: 'test',
      sessionId: 'older',
      title: 'Older chat',
      cwd: f.session('older', 0).cwd,
      modifiedAt: 1000,
      excerpt: `${'word '.repeat(60).trim()}…`,
    },
  ])
  assert.deepEqual(
    index
      .search(f.worktrees, 'SNOWFLAKE')
      .map(({ sessionId, excerpt }) => [sessionId, excerpt]),
    [
      ['newer', 'Rotate snowflake credentials'],
      ['older', 'Add Snowflake semantic views'],
    ],
  )
  const [match] = index.search(f.worktrees, 'views semantic')
  assert.equal(match.sessionId, 'older')
  // The latest matching message is excerpted around its earliest term, on one line.
  assert.match(match.excerpt, /^…(word )+The semantic views load now\. /)
  assert.ok(match.excerpt.endsWith('…'))
  assert.deepEqual(index.search(f.worktrees, 'semantic credentials'), [])
  // Terms too short for the trigram index still match.
  assert.deepEqual(
    index.search(f.worktrees, 'Do').map(({ sessionId }) => sessionId),
    ['newer'],
  )

  // At most ten chats match.
  f.provider.sessions = Array.from({ length: 12 }, (_, index) =>
    f.session(`many${index}`, index),
  )
  for (const { sessionId } of f.provider.sessions)
    f.provider.messages.set(sessionId, ['common text'])
  await index.update([f.provider])
  assert.deepEqual(
    index.search(f.worktrees, 'common').map(({ sessionId }) => sessionId),
    Array.from({ length: 10 }, (_, index) => `many${11 - index}`),
  )
})

test('searches find only chats whose working directory is in one of the directories', async (t) => {
  const f = await fixture(t)
  const main = join(f.directory, 'main')
  const linked = join(f.directory, 'linked')
  const session = (
    sessionId: string,
    cwd: string,
    modifiedAt: number,
  ): ChatSession => ({ sessionId, title: sessionId, cwd, modifiedAt })
  f.provider.sessions = [
    session('main', main, 1),
    session('nested', join(main, 'packages', 'app'), 2),
    session('linked', linked, 3),
    session('prefixed', `${main}-copy`, 4),
    session('unrecorded', '', 5),
    // Newer than the chats in the directories, and more than one search returns.
    ...Array.from({ length: 12 }, (_, index) =>
      session(`other${index}`, join(f.directory, 'other'), 10 + index),
    ),
  ]
  for (const { sessionId } of f.provider.sessions)
    f.provider.messages.set(sessionId, ['common text'])
  // An unrecorded directory must not resolve to a directory being searched.
  t.mock.method(process, 'cwd', () => main)
  const index = f.open()
  await index.update([f.provider])
  for (const query of ['', 'common'])
    assert.deepEqual(
      index.search([main, linked], query).map(({ sessionId }) => sessionId),
      ['linked', 'nested', 'main'],
    )
  assert.deepEqual(index.search([], ''), [])
})

test('updates follow the listing', async (t) => {
  const f = await fixture(t)
  f.provider.sessions = [f.session('one', 1), f.session('two', 1)]
  f.provider.messages.set('one', ['question'])
  f.provider.messages.set('two', ['other question'])
  const index = f.open()
  await index.update([f.provider])

  f.provider.sessions = [{ ...f.session('one', 1), title: 'Renamed' }]
  await index.update([f.provider])
  assert.deepEqual(
    index.search(f.worktrees, 'question').map(({ title }) => title),
    ['Renamed'],
  )

  // A provider that cannot list its sessions keeps its indexed sessions.
  t.mock.method(f.provider, 'listSessions', async () => {
    throw new Error('Unavailable')
  })
  await index.update([f.provider])
  assert.equal(index.search(f.worktrees, '').length, 1)
})

test('searches start one update at a time once the index is stale', async (t) => {
  const f = await fixture(t)
  f.provider.sessions = [f.session('one', 1)]
  f.provider.messages.set('one', ['first prompt'])
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const indexer = new LocalChatHistoryIndexer(f.path, [f.provider])
  const updates = t.mock.method(indexer, 'update')
  const history = new ChatHistory(f.path, indexer)
  t.after(() => history.close())
  let refreshes = 0
  history.setOnRefreshedListener(() => refreshes++)

  assert.deepEqual(history.search(f.worktrees, 'first'), {
    chats: [],
    indexing: true,
  })
  assert.equal(history.search(f.worktrees, 'first').indexing, true)
  await history.refresh()
  assert.equal(updates.mock.callCount(), 1)
  assert.equal(refreshes, 1)
  assert.equal(history.search(f.worktrees, 'first').chats.length, 1)

  f.provider.messages.set('one', ['first prompt', 'appended prompt'])
  f.provider.sessions = [f.session('one', 2)]
  now = 9_999
  assert.deepEqual(history.search(f.worktrees, 'appended'), {
    chats: [],
    indexing: false,
  })
  now = 10_000
  assert.equal(history.search(f.worktrees, 'appended').indexing, true)
  await history.refresh()
  assert.equal(updates.mock.callCount(), 2)
  assert.equal(history.search(f.worktrees, 'appended').chats.length, 1)

  // A failed update is logged and still lets searches continue.
  updates.mock.mockImplementation(async () => {
    throw new Error('Update failed')
  })
  now = 20_000
  history.search(f.worktrees, '')
  await history.refresh()
  assert.equal(refreshes, 3)
  assert.equal(history.search(f.worktrees, 'appended').chats.length, 1)

  const closing = t.mock.method(indexer, 'close')
  await history.close()
  assert.equal(closing.mock.callCount(), 1)
  assert.throws(() => history.search(f.worktrees, ''), /closed/)
})
