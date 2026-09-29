import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ChatStore } from '../../src/server/chats/chat-store.ts'
import { ChatService } from '../../src/server/chats/chat-service.ts'
import {
  codexProvider,
  type ChatTitleRequests,
  type ChatTitles,
} from '../../src/server/chats/chat-providers.ts'
import { readCodexTitles } from '../../src/server/chats/codex-chat-title.ts'
import type { ChatReport } from '../../src/shared/chats.ts'

const worktree = { project: '/project', path: '/project/branch' }
const processIdentity = { pid: 20, startedAt: 'codex-start' }
const processEntry = {
  ...processIdentity,
  parentPid: 10,
  name: 'codex',
  command: 'codex',
}
function report(extra: Partial<ChatReport> = {}): ChatReport {
  return {
    provider: 'codex',
    sessionId: 'first',
    terminalId: 'first',
    process: processIdentity,
    activity: 'idle',
    observedAt: 1,
    metadataRoot: '/home',
    ...extra,
  }
}
function store() {
  return new ChatStore(async () => new Map([[20, processEntry]]))
}
function titlesFor(requests: ChatTitleRequests, title = 'Title'): ChatTitles {
  return new Map(
    [...requests].map(([root, ids]) => [
      root,
      new Map([...ids].map((id) => [id, `${title} ${id}`])),
    ]),
  )
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

test('title jobs run on insertion and each minute, independently of activity and process reconciliation', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let title = 'Initial'
  let failed = false
  const read = t.mock.method(
    codexProvider,
    'readTitles',
    async (requests: ChatTitleRequests) => {
      if (failed) throw new Error('Metadata unavailable')
      return title ? titlesFor(requests, title) : new Map()
    },
  )
  const registry = store()
  const service = new ChatService(undefined, registry)
  await service.listen()
  t.after(() => service.close())
  await registry.activity('editor', worktree, report())
  await registry.settled()
  assert.equal(read.mock.callCount(), 1)
  assert.equal(registry.list().chats[0].title, 'Initial first')

  title = 'Renamed'
  await registry.activity(
    'editor',
    worktree,
    report({
      observedAt: 2,
      activity: 'working',
      message: 'Latest prompt',
      turnEvent: true,
    }),
  )
  await registry.reconcile()
  await registry.settled()
  assert.equal(read.mock.callCount(), 1)
  t.mock.timers.tick(59_999)
  await registry.settled()
  assert.equal(read.mock.callCount(), 1)
  const before = registry.list().chats[0]
  t.mock.timers.tick(1)
  await registry.settled()
  assert.equal(read.mock.callCount(), 2)
  assert.deepEqual(registry.list().chats[0], {
    ...before,
    title: 'Renamed first',
  })

  const cached = registry.list()
  title = ''
  t.mock.timers.tick(60_000)
  await registry.settled()
  assert.equal(read.mock.callCount(), 3)
  assert.deepEqual(
    registry.list(),
    cached,
    'unavailable metadata retains the cached title without publication',
  )
  title = 'Renamed'
  t.mock.timers.tick(60_000)
  await registry.settled()
  assert.deepEqual(registry.list(), cached, 'unchanged titles do not publish')
  failed = true
  t.mock.timers.tick(60_000)
  await registry.settled()
  assert.deepEqual(
    registry.list(),
    cached,
    'failed reads preserve cached titles',
  )
  failed = false
  title = 'Available again'
  t.mock.timers.tick(60_000)
  await registry.settled()
  assert.equal(registry.list().chats[0].title, 'Available again first')
  await service.close()
  t.mock.timers.tick(120_000)
  await registry.refreshTitles()
  assert.equal(read.mock.callCount(), 6)
})

test('insertions during a title job coalesce into one follow-up including new roots and deduplicated sessions', async (t) => {
  const blocked = deferred()
  const entered = deferred()
  let running = 0
  let maximum = 0
  let first = true
  const read = t.mock.method(
    codexProvider,
    'readTitles',
    async (requests: ChatTitleRequests) => {
      maximum = Math.max(maximum, ++running)
      if (first) {
        first = false
        entered.resolve()
        await blocked.promise
      }
      running--
      return titlesFor(requests)
    },
  )
  const registry = store()
  t.after(() => registry.close())
  await registry.activity('editor', worktree, report())
  await entered.promise
  await registry.activity(
    'editor',
    worktree,
    report({
      terminalId: 'second',
      sessionId: 'second',
      metadataRoot: '/other',
      observedAt: 2,
      turnEvent: true,
    }),
  )
  await registry.activity(
    'editor',
    worktree,
    report({
      terminalId: 'third',
      sessionId: 'second',
      metadataRoot: '/other',
      observedAt: 3,
    }),
  )
  await registry.activity(
    'editor',
    worktree,
    report({ observedAt: 4, message: 'Latest', activity: 'working' }),
  )
  const before = registry.list().chats
  const periodic = registry.refreshTitles()
  assert.equal(registry.refreshTitles(), periodic)
  assert.equal(read.mock.callCount(), 1)
  blocked.resolve()
  await registry.settled()
  assert.equal(read.mock.callCount(), 2)
  assert.equal(maximum, 1)
  assert.deepEqual(
    read.mock.calls[1].arguments[0],
    new Map([
      ['/home', new Set(['first'])],
      ['/other', new Set(['second'])],
    ]),
  )
  assert.deepEqual(
    registry.list().chats.map((chat) => ({ ...chat, title: undefined })),
    before.map((chat) => ({ ...chat, title: undefined })),
  )
  assert.deepEqual(
    registry.list().chats.map(({ title }) => title),
    ['Title second', 'Title first', 'Title second'],
  )

  const publications: unknown[] = []
  registry.on('update', (snapshot) => publications.push(snapshot))
  read.mock.mockImplementation(async (requests: ChatTitleRequests) =>
    titlesFor(requests, 'Renamed'),
  )
  await registry.refreshTitles()
  assert.equal(publications.length, 1, 'all changed roots publish in one batch')
})

test('periodic requests reuse a running title job without queuing another pass', async (t) => {
  const entered = deferred()
  const blocked = deferred()
  const read = t.mock.method(
    codexProvider,
    'readTitles',
    async (requests: ChatTitleRequests) => {
      entered.resolve()
      await blocked.promise
      return titlesFor(requests)
    },
  )
  const registry = store()
  t.after(() => registry.close())
  await registry.activity('editor', worktree, report())
  await entered.promise
  const pending = Array.from({ length: 10 }, () => registry.refreshTitles())
  assert.ok(pending.every((job) => job === pending[0]))
  blocked.resolve()
  await Promise.all(pending)
  assert.equal(read.mock.callCount(), 1)
})

test('stale title results cannot update removed, replaced, or retargeted conversations', async (t) => {
  const blocked = deferred()
  const entered = deferred()
  let first = true
  const read = t.mock.method(
    codexProvider,
    'readTitles',
    async (requests: ChatTitleRequests) => {
      if (first) {
        first = false
        entered.resolve()
        await blocked.promise
        return titlesFor(requests, 'Obsolete')
      }
      return new Map()
    },
  )
  const entries = new Map([[20, processEntry]])
  const registry = new ChatStore(async () => entries)
  t.after(() => registry.close())
  await registry.activity('editor', worktree, report())
  await entered.promise
  entries.clear()
  await registry.reconcile()
  entries.set(20, processEntry)
  await registry.activity('editor', worktree, report())
  blocked.resolve()
  await registry.settled()
  assert.equal(
    registry.list().chats[0].title,
    undefined,
    'reinserting the same conversation does not admit its old read',
  )

  for (const replacement of [
    { sessionId: 'replacement' },
    { sessionId: 'replacement', metadataRoot: '/new-home' },
  ]) {
    const gate = deferred()
    const started = deferred()
    read.mock.mockImplementationOnce(async (requests: ChatTitleRequests) => {
      started.resolve()
      await gate.promise
      return titlesFor(requests, 'Obsolete')
    })
    const refresh = registry.refreshTitles()
    await started.promise
    await registry.activity(
      'editor',
      worktree,
      report({ ...replacement, observedAt: 2 }),
    )
    gate.resolve()
    await refresh
    assert.equal(registry.list().chats[0].title, undefined)
  }
})

test('closing waits for a title read and stops pending follow-ups and publications', async (t) => {
  const entered = deferred()
  const blocked = deferred()
  const read = t.mock.method(
    codexProvider,
    'readTitles',
    async (requests: ChatTitleRequests) => {
      entered.resolve()
      await blocked.promise
      return titlesFor(requests)
    },
  )
  const registry = store()
  await registry.activity('editor', worktree, report())
  await entered.promise
  await registry.activity(
    'editor',
    worktree,
    report({ terminalId: 'second', sessionId: 'second' }),
  )
  const before = registry.list()
  let closed = false
  const closing = registry.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false)
  blocked.resolve()
  await closing
  assert.equal(read.mock.callCount(), 1)
  assert.deepEqual(registry.list(), before)
  await registry.refreshTitles()
  assert.equal(read.mock.callCount(), 1)
})

test('Codex reads each resolved database once, queries live sessions only and isolates failed sources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-title-batch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const alias = join(root, 'alias')
  const separate = join(root, 'separate')
  const broken = join(root, 'broken')
  await Promise.all([home, alias, separate, broken].map((dir) => mkdir(dir)))
  await writeFile(join(alias, 'config.toml'), 'sqlite_home = "../home"')
  const shared = new DatabaseSync(join(home, 'state_5.sqlite'))
  shared.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT)',
  )
  const insert = shared.prepare('INSERT INTO threads VALUES (?, ?, ?)')
  insert.run('first', 'Original', '  Renamed  ')
  insert.run('second', '  ' + 'x'.repeat(600) + '  ', '')
  insert.run('history', 'Do not read historical titles', null)
  shared.close()
  const other = new DatabaseSync(join(separate, 'state_8.sqlite'))
  other.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT); INSERT INTO threads VALUES ('third', 'Other source')",
  )
  other.close()
  await writeFile(join(broken, 'state_5.sqlite'), 'not SQLite')
  const prepare = t.mock.method(DatabaseSync.prototype, 'prepare')
  const close = t.mock.method(DatabaseSync.prototype, 'close')
  const titles = await readCodexTitles(
    new Map([
      [home, new Set(['first', 'second', 'missing'])],
      [alias, new Set(['first'])],
      [broken, new Set(['unavailable'])],
      [separate, new Set(['third'])],
      [join(root, 'absent'), new Set(['missing'])],
      ['relative-home', new Set(['missing'])],
    ]),
  )
  assert.deepEqual(
    titles.get(home),
    new Map([
      ['first', 'Renamed'],
      ['second', 'x'.repeat(512)],
    ]),
  )
  assert.deepEqual(titles.get(alias), new Map([['first', 'Renamed']]))
  assert.deepEqual(titles.get(separate), new Map([['third', 'Other source']]))
  assert.equal(titles.has(broken), false)
  const queries = prepare.mock.calls.map(({ arguments: [sql] }) => sql)
  assert.equal(queries.filter((sql) => sql.startsWith('SELECT')).length, 2)
  assert.ok(
    queries
      .filter((sql) => sql.startsWith('SELECT'))
      .every((sql) => sql.endsWith('WHERE id = ?')),
  )
  assert.equal(queries.filter((sql) => sql.startsWith('PRAGMA')).length, 3)
  assert.equal(
    close.mock.callCount(),
    3,
    'including cleanup of the failed source',
  )
})

test('Codex title reads preserve Unicode metadata paths while sharing configured sources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-title-unicode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, '\u0130Home')
  const alias = join(root, 'alias')
  await Promise.all([home, alias].map((dir) => mkdir(dir)))
  await writeFile(join(alias, 'config.toml'), 'sqlite_home = "../\u0130Home"')
  const database = new DatabaseSync(join(home, 'state_5.sqlite'))
  try {
    database.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT); INSERT INTO threads VALUES ('session', 'Unicode home title')",
    )
  } finally {
    database.close()
  }
  const close = t.mock.method(DatabaseSync.prototype, 'close')
  const titles = await readCodexTitles(
    new Map([
      [home, new Set(['session'])],
      [alias, new Set(['session'])],
    ]),
  )
  assert.deepEqual(
    titles.get(home),
    new Map([['session', 'Unicode home title']]),
  )
  assert.deepEqual(titles.get(alias), titles.get(home))
  assert.equal(close.mock.callCount(), 1)
})
