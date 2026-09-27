import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { reportChatActivity } from '../src/server/chat-hook.ts'
import { WebSocket } from 'ws'
import { DatabaseSync } from 'node:sqlite'
import { readCodexTitle } from '../src/server/codex-chat-title.ts'
import { ChatStore } from '../src/server/chats.ts'
import { ChatService } from '../src/server/chat-service.ts'
import { codexProvider } from '../src/server/chat-providers.ts'
import { installProviderHooks } from '../src/server/chat-hooks.ts'
import {
  createProcessReader,
  type ChatProcess,
} from '../src/server/chat-processes.ts'
import {
  serverChatMessageSchema,
  type ChatReport,
  type ServerChatMessage,
} from '../src/shared/chats.ts'

const worktree = { project: '/project', path: '/project/branch' }

test('hook stdin preserves split UTF-8 and enforces its byte limit before mapping', async (t) => {
  const originalEnv = process.env
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!
  t.after(() => {
    process.env = originalEnv
    Object.defineProperty(process, 'stdin', stdin)
  })
  process.env = {
    ...originalEnv,
    ADE_CHAT_ENDPOINT: 'http://127.0.0.1:1',
    ADE_CHAT_ACTIVITY_TOKEN: 'test',
    ADE_TERMINAL_ID: 'test',
  }
  const message = 'Fix café 中文 🧪'
  const payload = {
    session_id: 'session',
    hook_event_name: 'UserPromptSubmit',
    prompt: message,
  }
  const activity = t.mock.method(codexProvider, 'activity', () => undefined)
  const bytes = Buffer.from(JSON.stringify(payload))
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from([...bytes].map((byte) => Buffer.from([byte]))),
  })
  await reportChatActivity('codex')
  assert.deepEqual(activity.mock.calls[0].arguments[0], payload)
  activity.mock.resetCalls()
  const padded = Buffer.concat([
    bytes,
    Buffer.alloc(1024 * 1024 - bytes.length, ' '),
  ])
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from([padded]),
  })
  await reportChatActivity('codex')
  assert.equal(activity.mock.callCount(), 1)
  activity.mock.resetCalls()
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from([padded, Buffer.from(' ')]),
  })
  await reportChatActivity('codex')
  assert.equal(activity.mock.callCount(), 0)
})

test('activity HTTP preserves split UTF-8 previews and bounds raw bytes', async (t) => {
  const store = new ChatStore(async () => processes())
  const service = new ChatService(undefined, store)
  await service.listen()
  t.after(() => service.close())
  const env = service.environment('editor', worktree)
  await store.inventory('editor', worktree, inventory)
  const message = 'Fix café 中文 🧪'
  const bytes = Buffer.from(JSON.stringify(report({ message })))
  const split = bytes.indexOf(Buffer.from('🧪')) + 1
  const post = async (chunks: Buffer[]) => {
    const request = httpRequest(new URL('/activity', env.ADE_CHAT_ENDPOINT), {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADE_CHAT_ACTIVITY_TOKEN}` },
    })
    const response = once(request, 'response')
    for (const chunk of chunks) {
      request.write(chunk)
      await delay(15)
    }
    request.end()
    const [result] = await response
    result.resume()
    return result.statusCode
  }
  assert.equal(
    await post([
      bytes.subarray(0, split),
      bytes.subarray(split, split + 1),
      bytes.subarray(split + 1),
    ]),
    204,
  )
  assert.equal(store.list().chats[0].message, message)
  const padded = Buffer.concat([
    bytes,
    Buffer.alloc(64 * 1024 - bytes.length, ' '),
  ])
  assert.equal(await post([padded]), 204)
  assert.equal(await post([padded, Buffer.from(' ')]), 413)
})
function processes() {
  return new Map<number, ChatProcess>([
    [
      10,
      {
        pid: 10,
        parentPid: 1,
        name: 'shell',
        command: 'shell',
        startedAt: 'shell-start',
      },
    ],
    [
      20,
      {
        pid: 20,
        parentPid: 10,
        name: 'codex.exe',
        command: 'codex',
        startedAt: 'codex-start',
      },
    ],
  ])
}
const inventory = [{ terminalId: 'terminal', pid: 10, title: 'My chat' }]
function report(extra: Partial<ChatReport> = {}): ChatReport {
  return {
    provider: 'codex',
    sessionId: 'session',
    terminalId: 'terminal',
    process: { pid: 20, startedAt: 'codex-start' },
    activity: 'idle',
    observedAt: Date.now(),
    ...extra,
  }
}

test('activity bursts share process validation with queued terminal inventories', async () => {
  const entries = processes()
  let scans = 0
  const store = new ChatStore(
    createProcessReader(async () => {
      scans++
      return new Map(entries)
    }),
  )
  await store.inventory('editor', worktree, inventory)
  entries.set(11, { ...entries.get(10)!, pid: 11 })
  const observedAt = Date.now()
  const reports = Array.from({ length: 12 }, (_, i) =>
    store.activity(
      'editor',
      report({
        observedAt: observedAt + i,
        message: `Prompt ${i}`,
        turnEvent: true,
      }),
    ),
  )
  const launched = store.inventory('editor', worktree, [
    { terminalId: 'new-terminal', pid: 11, title: 'New terminal' },
  ])
  assert.ok((await Promise.all(reports)).every(Boolean))
  assert.equal((await launched)[0]?.pid, 11)
  assert.equal(scans, 2, 'the burst and launch need only one additional scan')
  assert.equal(store.list().chats[0].message, 'Prompt 11')

  // The next arrival must inspect a new snapshot, even for a familiar PID.
  entries.set(20, { ...entries.get(20)!, startedAt: 'reused-pid' })
  assert.equal(
    await store.activity('editor', report({ observedAt: observedAt + 12 })),
    false,
  )
  assert.equal(scans, 3)
  await store.reconcile()
  assert.equal(store.list().chats.length, 0)
})

test('process scans batch arrivals during cooldown but refresh for arrivals after a scan starts', async () => {
  const entries = processes()
  let scans = 0
  let release!: () => void
  let started!: () => void
  const scanning = new Promise<void>((resolve) => {
    started = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let fail = false
  const read = createProcessReader(async () => {
    scans++
    if (fail) throw new Error('OS query failed')
    const snapshot = new Map(entries)
    if (scans === 1) {
      started()
      await blocked
    }
    return snapshot
  })
  const first = read()
  await scanning
  entries.set(11, { ...entries.get(10)!, pid: 11 })
  const duringScan = read()
  release()
  assert.equal((await first).has(11), false)
  // This arrival is in the cooldown preceding the second OS scan.
  await delay(20)
  const duringCooldown = read()
  const second = await duringScan
  assert.equal(second.has(11), true)
  assert.equal(await duringCooldown, second)
  assert.equal(scans, 2)
  fail = true
  await assert.rejects(read(), /OS query failed/)
  fail = false
  entries.delete(20)
  assert.equal(
    (await read()).has(20),
    false,
    'a failed scan must not poison the queue or reuse old identities',
  )
  assert.equal(scans, 4)
})

test('Codex maps only supported activity hooks and never needs termination hooks', () => {
  for (const event of codexProvider.events) {
    const result = codexProvider.activity({
      session_id: 's',
      hook_event_name: event,
    })
    assert.equal(
      result?.activity,
      ['PreToolUse', 'PostToolUse', 'UserPromptSubmit'].includes(event)
        ? 'working'
        : 'idle',
    )
  }
  assert.equal(
    codexProvider.activity({
      session_id: 's',
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
    })?.activity,
    'idle',
  )
  assert.equal(
    codexProvider.activity({
      session_id: 's',
      hook_event_name: 'SessionStart',
      source: 'compact',
    })?.activity,
    'working',
  )
  for (const event of ['SessionEnd', 'SubagentStart', 'SubagentStop'])
    assert.equal(
      codexProvider.activity({ session_id: 's', hook_event_name: event }),
      undefined,
    )
  assert.equal(codexProvider.activity({}), undefined)
  assert.equal(
    codexProvider.hookFile({ CODEX_HOME: '/custom' }),
    join('/custom', 'hooks.json'),
  )
})

test('hook merge preserves unrelated data, serializes concurrent installs and leaves invalid JSON untouched', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-hooks-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'hooks.json')
  const group = {
    matcher: 'custom',
    custom: true,
    hooks: [{ type: 'command', command: 'user hook', custom: 42 }],
  }
  await writeFile(
    path,
    JSON.stringify({
      custom: { preserved: true },
      hooks: { Stop: [group], Other: [{ hooks: [] }] },
    }),
  )
  await Promise.all(
    Array.from({ length: 3 }, () =>
      installProviderHooks(
        codexProvider,
        path,
        "C:/owner's dir/reporter.ts",
        'C:/node dir/node.exe',
      ),
    ),
  )
  const installed = await readFile(path, 'utf8')
  const document = JSON.parse(installed)
  assert.deepEqual(document.custom, { preserved: true })
  assert.deepEqual(document.hooks.Stop[0], group)
  assert.deepEqual(document.hooks.Other, [{ hooks: [] }])
  for (const event of codexProvider.events) {
    const handlers = document.hooks[event]
      .flatMap((entry: { hooks: unknown[] }) => entry.hooks)
      .filter(
        (entry: { statusMessage?: string }) =>
          entry.statusMessage === 'ADE chat activity',
      )
    assert.equal(handlers.length, 1)
    assert.match(handlers[0].commandWindows, /^& /)
    assert.ok(handlers[0].commandWindows.includes("owner''s dir"))
    assert.ok(handlers[0].command.includes("owner'\\''s dir"))
  }
  assert.equal(document.hooks.SessionEnd, undefined)
  assert.equal(
    await installProviderHooks(
      codexProvider,
      path,
      "C:/owner's dir/reporter.ts",
      'C:/node dir/node.exe',
    ),
    false,
  )
  assert.equal(await readFile(path, 'utf8'), installed)
  await writeFile(path, 'invalid user config')
  await assert.rejects(installProviderHooks(codexProvider, path, 'reporter'))
  assert.equal(await readFile(path, 'utf8'), 'invalid user config')
})

test('activity upserts idle, orders reports, replaces sessions and validates terminal ancestry', async () => {
  const entries = processes()
  const store = new ChatStore(async () => entries)
  assert.equal(await store.activity('editor', report()), false)
  const accepted = await store.inventory('editor', worktree, inventory)
  assert.equal(accepted[0].startedAt, 'shell-start')
  const start = Date.now() - 1000
  assert.equal(
    await store.activity('editor', report({ observedAt: start })),
    true,
  )
  assert.equal(store.list().chats[0].activity, 'idle')
  const originalId = store.list().chats[0].id
  await store.activity(
    'editor',
    report({ observedAt: start + 2, activity: 'working' }),
  )
  assert.equal(
    await store.activity('editor', report({ observedAt: start + 1 })),
    false,
  )
  assert.equal(store.list().chats[0].activity, 'working')
  assert.equal(
    await store.activity(
      'editor',
      report({ sessionId: 'next', observedAt: start + 3 }),
    ),
    true,
  )
  assert.equal(store.list().chats.length, 1)
  assert.notEqual(store.list().chats[0].id, originalId)
  assert.equal(await store.activity('other-editor', report()), false)
  entries.set(20, { ...entries.get(20)!, parentPid: 99 })
  assert.equal(await store.activity('editor', report()), false)
  assert.equal(
    await store.activity('editor', report({ observedAt: Date.now() + 60_000 })),
    false,
  )
})

test('only reconciliation removes terminated chats; quiet idle and failed process queries retain them', async () => {
  const entries = processes()
  let fail = false
  const store = new ChatStore(async () => {
    if (fail) throw new Error('OS failed')
    return entries
  })
  await store.inventory('editor', worktree, inventory)
  await store.activity('editor', report({ observedAt: 1 }))
  await store.inventory('editor', worktree, [])
  await store.reconcile()
  assert.equal(store.list().chats.length, 1)
  fail = true
  await assert.rejects(store.reconcile())
  assert.equal(store.list().chats.length, 1)
  fail = false
  entries.set(20, { ...entries.get(20)!, startedAt: 'reused-pid' })
  assert.equal(store.list().chats.length, 1)
  await store.reconcile()
  assert.equal(store.list().chats.length, 0)
  entries.set(10, { ...entries.get(10)!, startedAt: 'reused-shell' })
  assert.deepEqual(
    await store.inventory('editor', worktree, [
      { ...inventory[0], startedAt: 'shell-start' },
    ]),
    [],
  )
})

async function connection(
  t: TestContext,
  env: NodeJS.ProcessEnv,
  startedAt = Date.now(),
  token = env.ADE_CHAT_EXTENSION_TOKEN,
) {
  const url = new URL('/extension', env.ADE_CHAT_ENDPOINT)
  url.protocol = 'ws:'
  url.searchParams.set('activation', randomUUID())
  url.searchParams.set('startedAt', String(startedAt))
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  t.after(() => socket.terminate())
  const messages: ServerChatMessage[] = []
  socket.on('message', (data) =>
    messages.push(serverChatMessageSchema.parse(JSON.parse(data.toString()))),
  )
  await once(socket, 'open')
  const take = async (
    predicate: (message: ServerChatMessage) => boolean,
  ): Promise<ServerChatMessage> => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate)
      if (index >= 0) return messages.splice(index, 1)[0]
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Message timeout: ${JSON.stringify(messages)}`)
  }
  return {
    socket,
    messages,
    take,
    send: (message: unknown) => socket.send(JSON.stringify(message)),
  }
}

test(
  'loopback service authenticates activity and focuses only a ready current extension; superseded requests cancel',
  { timeout: 10_000 },
  async (t) => {
    const entries = processes()
    const store = new ChatStore(async () => entries)
    const service = new ChatService(undefined, store)
    await service.listen()
    t.after(() => service.close())
    const sourceEnv = service.environment('source', {
      project: '/project',
      path: '/other',
    })
    const targetEnv = service.environment('target', worktree)
    assert.equal(sourceEnv.ADE_CHAT_EXTENSION_TOKEN, undefined)
    assert.equal(targetEnv.ADE_CHAT_EXTENSION_TOKEN, undefined)
    sourceEnv.ADE_CHAT_EXTENSION_TOKEN = service.extensionToken('source')
    targetEnv.ADE_CHAT_EXTENSION_TOKEN = service.extensionToken('target')
    const source = await connection(t, sourceEnv)
    const target = await connection(t, targetEnv, 1)
    target.send({ type: 'inventory', id: 'inventory', terminals: inventory })
    await target.take(
      (message) => message.type === 'result' && message.id === 'inventory',
    )
    const post = (token: string | undefined, body = report()) =>
      fetch(new URL('/activity', targetEnv.ADE_CHAT_ENDPOINT), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
    assert.equal((await post(targetEnv.ADE_CHAT_EXTENSION_TOKEN)).status, 403)
    assert.equal((await post(sourceEnv.ADE_CHAT_ACTIVITY_TOKEN)).status, 409)
    assert.equal((await post(targetEnv.ADE_CHAT_ACTIVITY_TOKEN)).status, 204)
    await assert.rejects(
      connection(t, targetEnv, 2, targetEnv.ADE_CHAT_ACTIVITY_TOKEN),
      /403/,
    )
    const chatId = store.list().chats[0].id
    let navigationId = ''
    service.onNavigate = (id, input) => {
      navigationId = id
      assert.deepEqual(input, worktree)
    }
    source.send({ type: 'activate', id: 'go', chatId })
    while (!navigationId) await new Promise((resolve) => setTimeout(resolve, 5))
    const baseline = service.activation('target')
    service.viewReady(navigationId, undefined, baseline)
    assert.equal(
      target.messages.some((message) => message.type === 'focus'),
      false,
    )
    source.send({ type: 'activate', id: 'loading-before', chatId })
    await source.take(
      (message) => message.type === 'result' && message.id === 'go',
    )
    service.viewReady(navigationId, undefined, baseline)
    target.send({ type: 'inventory', id: 'still-old', terminals: inventory })
    await target.take(
      (message) => message.type === 'result' && message.id === 'still-old',
    )
    assert.equal(
      target.messages.some((message) => message.type === 'focus'),
      false,
    )
    const fresh = await connection(t, targetEnv, 2)
    // A second click after connection but before inventory must keep the
    // document's baseline; capturing the activation again would wait forever.
    source.send({ type: 'activate', id: 'loading-again', chatId })
    await source.take(
      (message) => message.type === 'result' && message.id === 'loading-before',
    )
    service.viewReady(navigationId, undefined, baseline)
    fresh.send({
      type: 'inventory',
      id: 'restored',
      terminals: [{ ...inventory[0], startedAt: 'shell-start' }],
    })
    const focus = await fresh.take((message) => message.type === 'focus')
    assert.equal(focus.type, 'focus')
    if (focus.type !== 'focus') throw new Error('Expected focus')
    assert.equal(focus.terminalId, 'terminal')
    await assert.rejects(connection(t, targetEnv, 1), /403/)
    source.send({ type: 'activate', id: 'again', chatId })
    const cancelled = await fresh.take(
      (message) => message.type === 'cancel-focus',
    )
    assert.equal('id' in cancelled && cancelled.id, focus.id)
    const superseded = await source.take(
      (message) => message.type === 'result' && message.id === 'loading-again',
    )
    assert.ok(
      superseded.type === 'result' && superseded.error?.includes('Superseded'),
    )
    service.viewReady(navigationId, undefined, baseline)
    const next = await fresh.take((message) => message.type === 'focus')
    assert.equal(next.type, 'focus')
    if (next.type !== 'focus') throw new Error('Expected focus')
    fresh.send({ type: 'focused', id: focus.id }) // late acknowledgement must not finish the new navigation
    fresh.send({ type: 'focused', id: next.id })
    const result = await source.take(
      (message) => message.type === 'result' && message.id === 'again',
    )
    assert.ok(result.type === 'result' && !result.error)
    service.releaseEditor('target')
    assert.equal(store.list().chats.length, 1)
    entries.delete(20)
    await store.reconcile()
    assert.equal(store.list().chats.length, 0)
  },
)

test('Codex previews use only prompt and turn-end hooks, with bounded text', () => {
  const hook = (hook_event_name: string, fields: object) =>
    codexProvider.activity({
      session_id: 'session',
      hook_event_name,
      ...fields,
    })
  assert.equal(hook('UserPromptSubmit', {})?.turnEvent, true)
  assert.equal(hook('Stop', {})?.turnEvent, true)
  assert.equal(hook('PreToolUse', {})?.turnEvent, false)
  assert.equal(
    hook('UserPromptSubmit', { prompt: '  Fix the tests  ' })?.message,
    'Fix the tests',
  )
  assert.equal(
    hook('Stop', { last_assistant_message: 'Tests pass.' })?.message,
    'Tests pass.',
  )
  assert.equal(
    hook('PreToolUse', { prompt: 'ignore', last_assistant_message: 'ignore' })
      ?.message,
    undefined,
  )
  assert.equal(
    hook('Stop', { last_assistant_message: null })?.message,
    undefined,
  )
  assert.equal(
    hook('UserPromptSubmit', { prompt: 'x'.repeat(9000) })?.message?.length,
    4000,
  )
})

test('chat order follows prompt and turn-end time, including empty replies, without moving on tool activity', async () => {
  const entries = processes()
  entries.set(11, { ...entries.get(10)!, pid: 11 })
  entries.set(21, { ...entries.get(20)!, pid: 21, parentPid: 11 })
  const store = new ChatStore(async () => entries)
  await store.inventory('editor', worktree, [
    ...inventory,
    { ...inventory[0], terminalId: 'second', pid: 11 },
  ])
  await store.activity('editor', report({ observedAt: 1 }))
  const second = (extra: Partial<ChatReport> = {}) =>
    report({
      terminalId: 'second',
      process: { pid: 21, startedAt: 'codex-start' },
      ...extra,
    })
  await store.activity('editor', second({ observedAt: 2 }))
  const order = () => store.list().chats.map((chat) => chat.terminalId)
  assert.deepEqual(
    order(),
    ['terminal', 'second'],
    'unobserved turns keep a stable order',
  )
  await store.activity(
    'editor',
    second({
      observedAt: 3,
      turnEvent: true,
      message: 'Prompt',
      activity: 'working',
    }),
  )
  assert.deepEqual(order(), ['second', 'terminal'])
  await store.activity('editor', report({ observedAt: 4, activity: 'working' }))
  assert.deepEqual(order(), ['second', 'terminal'], 'tool hooks do not reorder')
  await store.activity(
    'editor',
    report({ observedAt: 5, turnEvent: true, activity: 'idle' }),
  )
  assert.deepEqual(
    order(),
    ['terminal', 'second'],
    'turn end reorders even without message text',
  )
  const revision = store.list().revision
  await store.activity('editor', second({ observedAt: 6, turnEvent: true }))
  await store.activity('editor', report({ observedAt: 7, turnEvent: true }))
  assert.ok(store.list().revision > revision)
  assert.equal(store.list().chats[0].lastTurnAt, 7)
  assert.equal(
    await store.activity('editor', report({ observedAt: 5, turnEvent: true })),
    false,
  )
  assert.equal(store.list().chats[0].lastTurnAt, 7)
})

test('provider titles load from read-only Codex metadata and refresh independently of activity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-chat-title-'))
  let database: DatabaseSync | undefined = undefined
  const entries = processes()
  const store = new ChatStore(async () => entries)
  t.after(async () => {
    await store.settled()
    database?.close()
    await rm(root, { recursive: true, force: true })
  })
  await store.inventory('editor', worktree, inventory)
  const start = Date.now() - 1000
  await store.activity(
    'editor',
    report({ observedAt: start, metadataRoot: root, message: 'First prompt' }),
  )
  await store.settled()
  assert.equal(
    store.list().chats[0].title,
    undefined,
    'missing metadata remains a skeleton',
  )
  assert.equal(store.list().chats[0].message, 'First prompt')
  database = new DatabaseSync(join(root, 'state_5.sqlite'))
  database.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT)',
  )
  database
    .prepare('INSERT INTO threads VALUES (?, ?, ?)')
    .run('session', 'First prompt', null)
  await store.reconcile()
  assert.equal(store.list().chats[0].title, 'First prompt')
  const revision = store.list().revision
  database.prepare('UPDATE threads SET name = ?').run('Renamed in Codex')
  await store.reconcile()
  assert.equal(store.list().chats[0].title, 'Renamed in Codex')
  assert.ok(store.list().revision > revision)
  await store.inventory('editor', worktree, [
    { ...inventory[0], title: 'Different terminal title' },
  ])
  assert.equal(store.list().chats[0].title, 'Renamed in Codex')
  await store.activity(
    'editor',
    report({ observedAt: start + 2, message: 'Final assistant answer' }),
  )
  assert.equal(
    store.list().chats[0].message,
    'Final assistant answer',
    'same activity still publishes a new message',
  )
  await store.activity(
    'editor',
    report({ observedAt: start + 1, message: 'Late old prompt' }),
  )
  assert.equal(store.list().chats[0].message, 'Final assistant answer')
  await store.activity(
    'editor',
    report({ observedAt: start + 3, activity: 'working' }),
  )
  assert.equal(
    store.list().chats[0].message,
    'Final assistant answer',
    'tool hooks retain the last received text',
  )
  await store.activity(
    'editor',
    report({ observedAt: start + 4, sessionId: 'other' }),
  )
  await store.settled()
  assert.equal(store.list().chats[0].title, undefined)
  assert.equal(
    store.list().chats[0].message,
    undefined,
    'session replacement cannot leak previous content',
  )
  const configHome = join(root, 'custom')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(configHome)
  await writeFile(
    join(configHome, 'config.toml'),
    `sqlite_home = ${JSON.stringify(root.replaceAll('\\', '/'))}`,
  )
  assert.equal(await readCodexTitle(configHome, 'session'), 'Renamed in Codex')
  assert.equal(await readCodexTitle(root, 'missing'), undefined)
})
