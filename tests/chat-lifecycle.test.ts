import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { CodexChatProvider } from '../src/server/chat-providers/codex/provider'
import { ChatStore } from '../src/server/chat-store'
import type { ProcessProbe } from '../src/server/process-probe'
import type { Chat } from '../src/shared/api'
import { createCodexMetadata } from './fixtures/codex-metadata'

class Processes implements ProcessProbe {
  alive = new Set([123, 456])
  calls: number[] = []
  isAlive(pid: number): boolean {
    this.calls.push(pid)
    return this.alive.has(pid)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-lifecycle-'))
  const provider = new CodexChatProvider('unused', directory)
  const processes = new Processes()
  const store = new ChatStore(processes, [provider])
  t.after(async () => {
    store.close()
    await rm(directory, { recursive: true, force: true })
  })
  const snapshots: Record<string, Chat>[] = []
  store.setOnChangedListener((snapshot) => snapshots.push(snapshot))
  const report = (
    sessionId: string,
    event: string,
    fields: Record<string, unknown> = {},
  ) =>
    store.report('codex', {
      session_id: sessionId,
      hook_event_name: event,
      cwd: directory,
      pid: 123,
      ...fields,
    })
  return { directory, store, provider, processes, snapshots, report }
}

test('startup, resume and startup-session shutdown leave only the resumed chat', async (t) => {
  const { store, report, snapshots } = await fixture(t)
  await report('empty', 'SessionStart', { source: 'startup' })
  await report('existing', 'SessionStart', { source: 'resume' })
  await report('existing', 'UserPromptSubmit', { prompt: 'Continue working' })
  await report('empty', 'SessionEnd')
  assert.deepEqual(Object.keys(store.snapshot), ['codex:existing'])
  assert.equal(store.snapshot['codex:existing'].status, 'working')
  assert.deepEqual(snapshots.at(-1), store.snapshot)

  // A server may first hear about the unused startup session when it ends.
  const notifications = snapshots.length
  await report('unseen', 'SessionEnd')
  await report('empty', 'SessionEnd')
  assert.equal(snapshots.length, notifications)
  assert.deepEqual(Object.keys(store.snapshot), ['codex:existing'])
})

test('a delayed startup report leaves the working chat and its notifications untouched', async (t) => {
  const { store, report, snapshots } = await fixture(t)
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const finished: Chat[] = []
  store.setOnTurnFinishedListener((chat) => finished.push(chat))
  const working = report('session', 'UserPromptSubmit', {
    prompt: 'Keep working',
  })
  now = 999
  const startup = report('session', 'SessionStart', { source: 'startup' })
  await Promise.all([working, startup])
  assert.equal(store.snapshot['codex:session'].status, 'working')
  assert.equal(store.snapshot['codex:session'].description, 'Keep working')
  assert.equal(store.snapshot['codex:session'].mtime, 0)
  assert.equal(snapshots.length, 1)
  assert.deepEqual(finished, [])

  await report('session', 'Stop')
  assert.equal(store.snapshot['codex:session'].status, 'idle')
  assert.equal(finished.length, 1)
  await report('session', 'UserPromptSubmit')
  assert.equal(store.snapshot['codex:session'].status, 'working')
})

for (const concurrent of [false, true]) {
  test(`startup recovers from a failed working read${concurrent ? ' still pending at receipt' : ''}`, async (t) => {
    const { directory, store, report, snapshots } = await fixture(t)
    const database = createCodexMetadata(directory)
    try {
      let now = 0
      t.mock.method(Date, 'now', () => now)
      database.exec('BEGIN EXCLUSIVE')
      const failed = assert.rejects(
        report('session', 'UserPromptSubmit', { prompt: 'Keep working' }),
        /database is locked/,
      )
      database.exec('ROLLBACK')
      if (!concurrent) await failed
      now = 500
      const startup = report('session', 'SessionStart', { source: 'startup' })
      await Promise.all([failed, startup])
      assert.equal(store.snapshot['codex:session'].status, 'idle')
      assert.equal(store.snapshot['codex:session'].mtime, 500)
      assert.equal(snapshots.length, 1)
    } finally {
      database.close()
    }
  })
}

test('startup recovery cannot erase a newer working report during concurrent reads', async (t) => {
  const { store, provider, report, snapshots } = await fixture(t)
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const gate = deferred()
  const workingRead = deferred()
  const readReport = provider.readReport.bind(provider)
  t.mock.method(provider, 'readReport', async (value: unknown) => {
    const event = value as { prompt?: string; hook_event_name: string }
    if (event.prompt === 'Failed prompt') {
      await gate.promise
      throw new Error('Metadata unavailable')
    }
    const incoming = await readReport(value)
    if (event.hook_event_name === 'PreToolUse') workingRead.resolve()
    return incoming
  })
  const finished: Chat[] = []
  store.setOnTurnFinishedListener((chat) => finished.push(chat))
  const failed = assert.rejects(
    report('session', 'UserPromptSubmit', { prompt: 'Failed prompt' }),
    /Metadata unavailable/,
  )
  now = 100
  const startup = report('session', 'SessionStart', { source: 'startup' })
  now = 200
  const working = report('session', 'PreToolUse')
  await workingRead.promise
  gate.resolve()
  await Promise.all([failed, startup, working])
  const previous = store.snapshot
  now = 300
  await report('session', 'SessionStart', { source: 'startup' })
  assert.deepEqual(store.snapshot, previous)
  assert.equal(store.snapshot['codex:session'].status, 'working')
  assert.equal(snapshots.length, 2)
  assert.deepEqual(finished, [])
})

test('tool activity updates status through permission waits and retains the description', async (t) => {
  const { store, report } = await fixture(t)
  await report('session', 'UserPromptSubmit', { prompt: 'Run the checks' })
  for (const [event, status] of [
    ['PreToolUse', 'working'],
    ['PermissionRequest', 'idle'],
    ['PostToolUse', 'working'],
  ]) {
    await report('session', event, {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: event === 'PostToolUse' ? 'Checks passed' : undefined,
    })
    assert.equal(store.snapshot['codex:session'].status, status)
    assert.equal(store.snapshot['codex:session'].description, 'Run the checks')
  }
  await report('session', 'Stop', {
    last_assistant_message: 'All checks passed',
  })
  assert.equal(store.snapshot['codex:session'].status, 'idle')
  assert.equal(store.snapshot['codex:session'].description, 'All checks passed')
})

test('chat recency advances only on user prompts and turn endings', async (t) => {
  const { store, report } = await fixture(t)
  let now = 0
  t.mock.method(Date, 'now', () => now)
  await report('session', 'SessionStart', { source: 'startup' })
  assert.equal(store.snapshot['codex:session'].lastActivityAt, undefined)
  now = 100
  await report('session', 'UserPromptSubmit', { prompt: 'Keep working' })
  now = 200
  await report('other', 'UserPromptSubmit')
  for (const [event, source] of [
    ['PreToolUse', undefined],
    ['PermissionRequest', undefined],
    ['PostToolUse', undefined],
    ['SessionStart', 'compact'],
    ['SessionStart', 'resume'],
  ] as const) {
    now += 2000
    await report('session', event, { source })
    const chat = store.snapshot['codex:session']
    assert.equal(chat.mtime, now)
    assert.equal(chat.lastActivityAt, 100)
    assert.ok(
      chat.lastActivityAt < store.snapshot['codex:other'].lastActivityAt!,
    )
  }
  for (const event of ['Stop', 'UserPromptSubmit', 'Interrupt']) {
    now += 2000
    await report('session', event)
    assert.equal(store.snapshot['codex:session'].lastActivityAt, now)
  }
  now += 2000
  await report('unseen', 'PostToolUse')
  assert.equal(store.snapshot['codex:unseen'].lastActivityAt, undefined)
})

test('A to B to A recovers on the next prompt when the second A start is lost', async (t) => {
  const { store, report, snapshots } = await fixture(t)
  await report('A', 'SessionStart', { source: 'startup' })
  await report('A', 'UserPromptSubmit', { prompt: 'Initial prompt' })
  await report('B', 'SessionStart', { source: 'resume' })
  await report('A', 'SessionEnd')
  assert.deepEqual(Object.keys(store.snapshot), ['codex:B'])
  // Resume A without delivering its SessionStart hook.
  await report('A', 'UserPromptSubmit', { prompt: 'Resumed prompt' })
  assert.equal(store.snapshot['codex:A'].description, 'Resumed prompt')
  assert.equal(store.snapshot['codex:A'].status, 'working')
  await report('B', 'SessionEnd')
  assert.deepEqual(Object.keys(store.snapshot), ['codex:A'])
  assert.deepEqual(snapshots.at(-1), store.snapshot)
})

test('late updates can restore ended sessions until the owner exits', async (t) => {
  const { store, report, processes } = await fixture(t)
  await report('session', 'SessionEnd')
  await report('session', 'Stop', { last_assistant_message: 'Late answer' })
  assert.equal(store.snapshot['codex:session'].description, 'Late answer')
  store.purge()
  assert.ok(store.snapshot['codex:session'])
  processes.alive.clear()
  store.purge()
  assert.deepEqual(store.snapshot, {})
})

test('an old owner cannot remove a session resumed by another process', async (t) => {
  const { store, report, snapshots } = await fixture(t)
  await report('session', 'SessionStart', { source: 'startup' })
  await report('session', 'SessionStart', { source: 'resume', pid: 456 })
  await report('session', 'UserPromptSubmit', { pid: 456, prompt: 'New owner' })
  const beforeEnd = store.snapshot
  const notifications = snapshots.length
  await report('session', 'SessionEnd')
  assert.deepEqual(store.snapshot, beforeEnd)
  assert.equal(snapshots.length, notifications)
  await report('session', 'SessionEnd', { pid: 456 })
  assert.deepEqual(store.snapshot, {})
  await report('session', 'SessionStart', { source: 'resume' })
  assert.equal(store.snapshot['codex:session'].pid, 123)
})

test('an end received during a metadata read removes the pending update', async (t) => {
  const { store, provider, report } = await fixture(t)
  const gate = deferred()
  const reading = deferred()
  const readReport = provider.readReport.bind(provider)
  t.mock.method(provider, 'readReport', async (value: unknown) => {
    const incoming = await readReport(value)
    if (!incoming.shouldPurge) {
      reading.resolve()
      await gate.promise
    }
    return incoming
  })
  const update = report('session', 'UserPromptSubmit', { prompt: 'Pending' })
  await reading.promise
  const end = report('session', 'SessionEnd')
  gate.resolve()
  await Promise.all([update, end])
  assert.deepEqual(store.snapshot, {})
})

test('process cleanup only probes remaining live chats', async (t) => {
  const { store, report, processes, snapshots } = await fixture(t)
  await report('ended', 'SessionEnd')
  await report('live', 'UserPromptSubmit')
  await report('other-owner', 'SessionEnd', { pid: 456 })
  store.purge()
  assert.deepEqual(processes.calls, [123])
  processes.alive.clear()
  store.purge()
  assert.deepEqual(store.snapshot, {})
  assert.deepEqual(snapshots.at(-1), {})
  processes.calls = []
  store.purge()
  assert.deepEqual(processes.calls, [])
})
