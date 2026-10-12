import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { ChatStore } from '../src/server/chat-store'
import {
  NodeProcessProbe,
  type ProcessProbe,
} from '../src/server/process-probe'
import type { Chat } from '../src/shared/api'
import { TestChatProvider } from './fixtures/chat-provider'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class Processes implements ProcessProbe {
  alive = new Set([123])
  calls: number[] = []
  isAlive(pid: number): boolean {
    this.calls.push(pid)
    return this.alive.has(pid)
  }
}

const chat: Omit<Chat, 'providerId' | 'sessionId' | 'mtime'> = {
  worktreePath: '/repo',
  title: 'Title',
  description: 'Description',
  status: 'working',
  pid: 123,
}
test('chats are upserted across worktrees with server timestamps and validated fields', async (t) => {
  const store = new ChatStore(new Processes(), [new TestChatProvider()])
  t.after(() => store.close())
  await upsert(store, 'first', chat)
  await upsert(store, 'second', { ...chat, worktreePath: '/other' })
  await upsert(store, 'third', chat)
  await upsert(store, 'first', {
    ...chat,
    title: 'Changed',
    status: 'idle',
  })
  assert.equal(Object.keys(store.snapshot).length, 3)
  assert.equal(store.snapshot['test:first'].title, 'Changed')
  assert.equal(store.snapshot['test:first'].status, 'idle')
  const snapshot = store.snapshot
  snapshot['test:first'].title = 'Mutated'
  delete snapshot['test:second']
  assert.equal(store.snapshot['test:first'].title, 'Changed')
  assert.ok(store.snapshot['test:second'])
  for (const invalid of [
    { ...chat, pid: 0 },
    { ...chat, pid: -1 },
    { ...chat, pid: 1.5 },
    { ...chat, status: 'busy' },
    { ...chat, title: null },
    { ...chat, description: null },
    { ...chat, worktreePath: '' },
  ]) {
    await assert.rejects(() => upsert(store, 'invalid', invalid))
  }
  await assert.rejects(() => upsert(store, '', chat))
})

test('a fresh store keeps missing descriptions undefined and merges only defined fields', async (t) => {
  const store = new ChatStore(new Processes(), [new TestChatProvider()])
  t.after(() => store.close())
  const { description, ...withoutDescription } = chat
  await upsert(store, 'session', withoutDescription)
  assert.ok(store.snapshot['test:session'])
  assert.equal(store.snapshot['test:session'].description, undefined)
  await upsert(store, 'session', {
    ...withoutDescription,
    description: undefined,
  })
  assert.equal(store.snapshot['test:session'].description, undefined)
  await upsert(store, 'session', chat)
  for (const value of [
    withoutDescription,
    { ...withoutDescription, description: undefined },
  ]) {
    await upsert(store, 'session', {
      ...value,
      title: 'Changed',
      status: 'idle',
    })
    assert.equal(store.snapshot['test:session'].description, description)
    assert.equal(store.snapshot['test:session'].title, 'Changed')
    assert.equal(store.snapshot['test:session'].status, 'idle')
  }
  await upsert(store, 'session', { ...chat, description: '' })
  assert.equal(store.snapshot['test:session'].description, '')
})

test('periodic cleanup checks each owner once and shutdown cancels the job', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const processes = new Processes()
  const store = new ChatStore(processes, [new TestChatProvider()], 100)
  t.after(() => store.close())
  await upsert(store, 'first', chat)
  await upsert(store, 'second', chat)
  await upsert(store, 'dead', { ...chat, pid: 456 })
  t.mock.timers.tick(100)
  assert.deepEqual(Object.keys(store.snapshot), ['test:first', 'test:second'])
  assert.deepEqual(processes.calls, [123, 456])
  processes.alive.clear()
  t.mock.timers.tick(100)
  assert.deepEqual(store.snapshot, {})
  store.close()
  const calls = processes.calls.length
  t.mock.timers.tick(1000)
  assert.equal(processes.calls.length, calls)
  await assert.rejects(() => upsert(store, 'new', chat), /closed/)
})

test('real process probing retains a live owner and purges it after exit', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
  })
  t.after(() => child.kill())
  await once(child, 'spawn')
  const store = new ChatStore(new NodeProcessProbe(), [new TestChatProvider()])
  t.after(() => store.close())
  await upsert(store, 'child', { ...chat, pid: child.pid! })
  store.purge()
  assert.ok(store.snapshot['test:child'])
  const exited = once(child, 'exit')
  child.kill()
  await exited
  store.purge()
  assert.deepEqual(store.snapshot, {})
})

test('permission and unexpected probe errors do not count as proof of death', async (t) => {
  const probe = new NodeProcessProbe()
  for (const code of ['EPERM', 'EACCES', 'UNKNOWN', 'ESRCH']) {
    const mock = t.mock.method(process, 'kill', () => {
      throw Object.assign(new Error(code), { code })
    })
    assert.equal(probe.isAlive(123), code !== 'ESRCH')
    mock.mock.restore()
  }
})

async function upsert(
  store: ChatStore,
  sessionId: string,
  value: object,
): Promise<void> {
  await store.report('test', {
    ...value,
    providerId: 'test',
    sessionId,
    mtime: Date.now(),
  })
}

test('provider namespaces isolate identical session IDs and only purge removes chats', async (t) => {
  const processes = new Processes()
  const store = new ChatStore(processes, [
    new TestChatProvider('first'),
    new TestChatProvider('second'),
  ])
  t.after(() => store.close())
  for (const id of ['first', 'second'])
    await store.report(id, {
      ...chat,
      providerId: id,
      sessionId: 'same',
      mtime: Date.now(),
    })
  assert.deepEqual(Object.keys(store.snapshot), ['first:same', 'second:same'])
  for (const id of ['first', 'second']) {
    assert.equal(store.snapshot[`${id}:same`].providerId, id)
    assert.equal(store.snapshot[`${id}:same`].sessionId, 'same')
  }
  await assert.rejects(store.report('first', null))
  assert.deepEqual(Object.keys(store.snapshot), ['first:same', 'second:same'])
  await store.report('first', {
    ...chat,
    providerId: 'first',
    sessionId: 'same',
    mtime: Date.now(),
    pid: 456,
  })
  store.purge()
  assert.deepEqual(Object.keys(store.snapshot), ['second:same'])
  await assert.rejects(store.report('unknown', {}), /Unknown chat provider/)
})

for (const nextTime of [100, 101]) {
  test(`receipt order survives delayed metadata when the next server timestamp is ${nextTime}`, async (t) => {
    let now = 100
    t.mock.method(Date, 'now', () => now)
    const provider = new TestChatProvider()
    const store = new ChatStore(new Processes(), [provider])
    t.after(() => store.close())
    if (nextTime === 101) await upsert(store, 'session', chat)

    const delayed = {
      ...chat,
      description: 'New prompt',
      providerId: 'test',
      sessionId: 'session',
      mtime: Date.now(),
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const readCompleted = deferred()
    const readReport = provider.readReport.bind(provider)
    t.mock.method(provider, 'readReport', async (value: unknown) => {
      if (value === delayed) await gate
      else readCompleted.resolve()
      return readReport(value)
    })

    const pending = store.report('test', delayed)
    now = nextTime
    const interrupt = upsert(store, 'session', {
      ...chat,
      description: undefined,
      status: 'idle',
    })
    await readCompleted.promise
    release()
    await Promise.all([pending, interrupt])
    store.purge()
    assert.deepEqual(store.snapshot['test:session'], {
      ...chat,
      description: 'New prompt',
      providerId: 'test',
      sessionId: 'session',
      status: 'idle',
      mtime: nextTime,
    })
  })
}

test('failed reports do not bypass preceding reads or block subsequent merges', async (t) => {
  const provider = new TestChatProvider()
  const store = new ChatStore(new Processes(), [provider])
  t.after(() => store.close())
  const gate = deferred()
  const readCompleted = deferred()
  const readReport = provider.readReport.bind(provider)
  t.mock.method(provider, 'readReport', async (value: unknown) => {
    const incoming = await readReport(value)
    if (incoming.description === 'Delayed prompt') await gate.promise
    if (incoming.description === 'Failure')
      throw new Error('Metadata unavailable')
    if (incoming.status === 'idle') readCompleted.resolve()
    return incoming
  })
  const first = upsert(store, 'session', {
    ...chat,
    description: 'Delayed prompt',
  })
  const failed = assert.rejects(
    upsert(store, 'session', { ...chat, description: 'Failure' }),
    /Metadata unavailable/,
  )
  const last = upsert(store, 'session', {
    ...chat,
    description: 'Latest answer',
    status: 'idle',
  })
  await readCompleted.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(store.snapshot, {})
  gate.resolve()
  await Promise.all([first, failed, last])
  assert.equal(store.snapshot['test:session'].description, 'Latest answer')
  assert.equal(store.snapshot['test:session'].status, 'idle')
})

test('shutdown prevents pending reports from repopulating the store', async (t) => {
  const provider = new TestChatProvider()
  const store = new ChatStore(new Processes(), [provider])
  t.after(() => store.close())
  const gate = deferred()
  const readReport = provider.readReport.bind(provider)
  t.mock.method(provider, 'readReport', async (value: unknown) => {
    await gate.promise
    return readReport(value)
  })
  const first = assert.rejects(upsert(store, 'first', chat), /closed/)
  const second = assert.rejects(upsert(store, 'second', chat), /closed/)
  store.close()
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(store.snapshot, {})
})

test('changes publish complete isolated snapshots, including dead chat removal', async (t) => {
  const processes = new Processes()
  const store = new ChatStore(processes, [new TestChatProvider()])
  t.after(() => store.close())
  const snapshots: Record<string, Chat>[] = []
  store.setOnChangedListener((snapshot) => snapshots.push(snapshot))
  await upsert(store, 'first', chat)
  await upsert(store, 'second', { ...chat, pid: 456 })
  await upsert(store, 'first', { ...chat, description: 'Updated' })
  assert.equal(snapshots.length, 3)
  assert.deepEqual(snapshots.at(-1), store.snapshot)
  assert.equal(snapshots[0]['test:first'].description, 'Description')
  snapshots[0]['test:first'].title = 'Mutated'
  assert.equal(store.snapshot['test:first'].title, 'Title')
  await assert.rejects(upsert(store, 'invalid', { ...chat, pid: 0 }))
  assert.equal(snapshots.length, 3)
  store.purge()
  assert.deepEqual(Object.keys(snapshots.at(-1)!), ['test:first'])
  assert.equal(snapshots.length, 4)
  store.purge()
  assert.equal(snapshots.length, 4)
  processes.alive.clear()
  store.purge()
  assert.deepEqual(snapshots.at(-1), {})
  store.close()
  store.purge()
  assert.equal(snapshots.length, 5)
})
