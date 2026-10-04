import assert from 'node:assert/strict'
import { EventEmitter, on } from 'node:events'
import { test, type TestContext } from 'node:test'
import type { Socket } from 'socket.io'
import { socketServer } from '../helpers/socket.ts'
import { CompanionClient } from '../../src/main/companion-client.ts'
import { CompanionState } from '../../src/main/companion-state.ts'
import type { CompanionState as DesktopCompanionState } from '../../src/shared/ipc.ts'
import { type WorktreeSnapshot } from '../../src/shared/companion.ts'

const snapshot = (revision: number): WorktreeSnapshot => ({
  revision,
  projects: ['project'],
  worktrees: [],
})

async function fixture(t: TestContext) {
  type Request = {
    socket: Socket
    event: string
    acknowledge: (reply: unknown) => void
  }
  const requests = new EventEmitter<{ request: [Request] }>()
  const incoming = on(requests, 'request', { signal: t.signal })
  const { url } = await socketServer(t, (socket) => {
    socket.onAny(
      (
        event: string,
        _input: unknown,
        acknowledge: (reply: unknown) => void,
      ) => {
        requests.emit('request', { socket, event, acknowledge })
      },
    )
    socket.emit('hello', { protocolVersion: 1 })
  })
  const client = new CompanionClient({
    url,
    reconnectDelayMs: 10,
    requestTimeoutMs: 2_000,
  })
  const state = new CompanionState(client)
  t.after(async () => {
    client.stop()
    await incoming.return?.()
  })
  const next = async (event: string) => {
    const request = (await incoming.next()).value![0] as Request
    assert.equal(request.event, event)
    return {
      socket: request.socket,
      reply: (value: WorktreeSnapshot) =>
        request.acknowledge({ ok: true, value }),
      fail: (error: string) => request.acknowledge({ ok: false, error }),
      push: (value: WorktreeSnapshot) =>
        request.socket.emit('desktopUpdateWorktrees', value),
    }
  }
  const wait = async (predicate: (value: DesktopCompanionState) => boolean) => {
    if (predicate(state.getCurrent())) return
    for await (const [value] of on(state, 'changed', { signal: t.signal })) {
      if (predicate(value)) return
    }
  }
  client.connect()
  return { client, state, next, wait }
}

test(
  'main fetches without a picker and accepts ordered command and broadcast snapshots once',
  { timeout: 5_000 },
  async (t) => {
    const { state, next, wait } = await fixture(t)
    const accepted: number[] = []
    state.on('snapshot', (value) => accepted.push(value.revision))
    const initial = await next('companionListWorktrees')
    assert.equal(state.getCurrent().loading, true)
    initial.push(snapshot(5))
    initial.reply(snapshot(4))
    await wait((value) => !value.loading)
    assert.equal(state.getCurrent().snapshot?.revision, 5)

    const refresh = state.refreshWorktrees()
    const refreshing = await next('companionRefreshWorktrees')
    refreshing.push(snapshot(7))
    refreshing.push(snapshot(6))
    refreshing.reply(snapshot(7))
    assert.equal(await refresh, undefined)
    assert.deepEqual(accepted, [5, 7])

    // Command replies go through the same acceptance path even without a push.
    const create = state.createWorktree({
      project: 'project',
      path: 'branch',
      baseBranch: 'main',
      branch: '',
    })
    ;(await next('companionCreateWorktree')).reply(snapshot(8))
    assert.equal(await create, undefined)
    const remove = state.deleteWorktree({ project: 'project', path: 'branch' })
    const deleting = await next('companionDeleteWorktree')
    deleting.push(snapshot(9))
    deleting.reply(snapshot(9))
    assert.equal(await remove, undefined)
    const clear = state.setWorktreeError({ project: 'project', path: 'branch' })
    ;(await next('companionSetWorktreeError')).reply(snapshot(10))
    assert.equal(await clear, undefined)
    assert.deepEqual(accepted, [5, 7, 8, 9, 10])
    assert.deepEqual(state.getCurrent().snapshot, snapshot(10))
  },
)

test(
  'main reloads after reconnect, accepts reset revisions and ignores old requests',
  { timeout: 5_000 },
  async (t) => {
    const { client, state, next, wait } = await fixture(t)
    const initial = await next('companionListWorktrees')
    initial.reply(snapshot(20))
    await wait((value) => !value.loading)
    // Hold an already-resolved transport reply across replacement of its
    // connection, so the state owner's stale-completion guard is exercised.
    let markReceived!: () => void
    let releaseReply!: () => void
    const received = new Promise<void>((resolve) => {
      markReceived = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseReply = resolve
    })
    const refresh = client.companionRefreshWorktrees.bind(client)
    t.mock.method(client, 'companionRefreshWorktrees', async () => {
      const result = await refresh()
      markReceived()
      await release
      return result
    })
    const pendingRefresh = state.refreshWorktrees()
    const oldRefresh = await next('companionRefreshWorktrees')
    oldRefresh.reply(snapshot(99))
    await received
    const pendingCreate = assert.rejects(
      state.createWorktree({
        project: 'project',
        path: 'branch',
        baseBranch: 'main',
        branch: '',
      }),
      /Disconnected/,
    )
    await next('companionCreateWorktree')
    client.connect()
    assert.equal(state.getCurrent().snapshot, null)
    const reconnect = await next('companionListWorktrees')
    assert.equal(state.getCurrent().loading, true)
    releaseReply()
    await Promise.all([pendingRefresh, pendingCreate])
    assert.equal(state.getCurrent().snapshot, null)
    assert.equal(state.getCurrent().loading, true)
    assert.equal(state.getCurrent().error, '')
    reconnect.reply(snapshot(0))
    await wait((value) => !value.loading)
    assert.equal(state.getCurrent().snapshot?.revision, 0)
    assert.equal(state.getCurrent().error, '')

    reconnect.socket.conn.close()
    const automatic = await next('companionListWorktrees')
    automatic.reply(snapshot(1))
    await wait((value) => !value.loading)
    assert.equal(state.getCurrent().snapshot?.revision, 1)
  },
)

test(
  'main owns load failures and a newer refresh supersedes older loading and errors',
  { timeout: 5_000 },
  async (t) => {
    const { state, next, wait } = await fixture(t)
    const initial = await next('companionListWorktrees')
    initial.fail('Initial list failed')
    await wait((value) => !value.loading)
    assert.equal(state.getCurrent().error, 'Initial list failed')
    assert.equal(state.getCurrent().snapshot, null)

    const older = state.refreshWorktrees()
    const olderRequest = await next('companionRefreshWorktrees')
    const newer = state.refreshWorktrees()
    const newerRequest = await next('companionRefreshWorktrees')
    assert.equal(state.getCurrent().error, '')
    olderRequest.fail('Superseded failure')
    await older
    assert.equal(state.getCurrent().loading, true)
    assert.equal(state.getCurrent().error, '')
    newerRequest.reply(snapshot(2))
    await newer
    assert.equal(state.getCurrent().loading, false)

    const failed = state.refreshWorktrees()
    ;(await next('companionRefreshWorktrees')).fail('Refresh failed')
    await failed
    assert.equal(state.getCurrent().error, 'Refresh failed')
    assert.equal(state.getCurrent().snapshot?.revision, 2)
    const rejected = assert.rejects(
      state.deleteWorktree({ project: 'project', path: 'main' }),
      /Protected/,
    )
    ;(await next('companionDeleteWorktree')).fail('Protected worktree')
    await rejected
    assert.equal(state.getCurrent().snapshot?.revision, 2)
  },
)

test(
  'main owns per-worktree local state and publishes it merged onto rows',
  { timeout: 5_000 },
  async (t) => {
    const { client, state, next, wait } = await fixture(t)
    const row = (path: string, error?: string) => ({
      project: 'project',
      path,
      branch: path,
      main: false,
      locked: false,
      prunable: false,
      editorServer: 'stopped' as const,
      ...(error && { error }),
    })
    ;(await next('companionListWorktrees')).reply({
      ...snapshot(1),
      worktrees: [row('a', 'Companion error'), row('b')],
    })
    await wait((value) => value.snapshot?.revision === 1)
    const rows = () => state.getCurrent().snapshot!.worktrees
    assert.deepEqual(rows(), [row('a', 'Companion error'), row('b')])

    const published: DesktopCompanionState[] = []
    state.on('changed', (value) => published.push(value))
    const a = { project: 'project', path: 'a' }
    const b = { project: 'project', path: 'b' }
    const finishA = state.startOpen(a)
    const finishB = state.startOpen(b)
    assert.equal(published.length, 2)
    assert.deepEqual(published.at(-1), state.getCurrent())
    assert.equal(rows()[0].opening, true)
    assert.equal(rows()[1].opening, true)
    assert.ok(rows()[1].lastOpenedAt! > rows()[0].lastOpenedAt!)
    const reopened = state.startOpen(a)
    assert.ok(rows()[0].lastOpenedAt! > rows()[1].lastOpenedAt!)
    finishA('First open failed')
    assert.equal(rows()[0].opening, true, 'opening lasts until every open ends')
    assert.equal(rows()[0].error, 'First open failed')
    reopened('Page failed')
    finishB()
    assert.equal(rows()[0].opening, undefined)
    assert.equal(rows()[1].opening, undefined)
    assert.equal(rows()[0].error, 'Page failed', 'an open failure stays local')
    assert.equal(rows()[1].error, undefined)

    state.setLocalError(a, 'Local error')
    assert.equal(rows()[0].error, 'Local error')
    state.setLocalError(a)
    assert.equal(rows()[0].error, 'Companion error')
    await state.rowRequest(b, async () => {
      throw new Error('Stop failed')
    })
    assert.equal(rows()[1].error, 'Stop failed')

    const reopening = state.startOpen(b)
    const recency = rows()[1].lastOpenedAt
    client.stop()
    await wait((value) => value.status.state !== 'connected')
    client.connect()
    ;(await next('companionListWorktrees')).reply({
      ...snapshot(0),
      worktrees: [row('b')],
    })
    await wait((value) => value.snapshot?.revision === 0)
    assert.deepEqual(
      rows(),
      [{ ...row('b'), lastOpenedAt: recency }],
      'a new connection keeps recency and drops opens, errors and gone rows',
    )
    reopening('Disconnected page')
    assert.equal(rows()[0].opening, undefined)
    assert.equal(rows()[0].error, undefined)
  },
)
