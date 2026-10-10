import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { Project } from '../src/server/options'
import { WorktreeStore } from '../src/server/worktree-store'
import type { Worktree } from '../src/shared/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const projects = [{ mainWorktreePath: '/first' }]
const first: Worktree[] = [
  { path: '/first', basename: 'first', branchName: 'main' },
]
const second: Worktree[] = [
  { path: '/second', basename: 'second', branchName: 'main' },
]

function fixture(t: TestContext) {
  const scans: Array<{
    projects: Project[]
    signal: AbortSignal
    result: ReturnType<typeof deferred<Worktree[]>>
  }> = []
  const store = new WorktreeStore(projects, async (projects, signal) => {
    assert.ok(signal)
    const result = deferred<Worktree[]>()
    scans.push({ projects, signal, result })
    signal.addEventListener('abort', () => result.reject(signal.reason), {
      once: true,
    })
    return result.promise
  })
  t.after(() => store.close())
  return { store, scans }
}

test('refresh requests share one loop and combine requests made during a scan', async (t) => {
  const { store, scans } = fixture(t)
  const updates: Worktree[][] = []
  store.setOnChangedListener((snapshot) => updates.push(snapshot))
  const a = store.queueRefresh()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const b = store.queueRefresh()
  const c = store.queueRefresh()
  assert.equal(a, b)
  assert.equal(b, c)
  for (let i = 0; i < 20; i++) assert.equal(store.queueRefresh(), b)
  assert.equal(scans.length, 1)
  let pendingComplete = false
  void b.then(() => {
    pendingComplete = true
  })

  scans[0].result.resolve(first)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(scans.length, 2)
  assert.equal(pendingComplete, false)
  assert.deepEqual(updates, [first])

  scans[1].result.resolve(second)
  await Promise.all([a, b, c])
  assert.equal(scans.length, 2)
  assert.deepEqual(store.snapshot, second)
  assert.deepEqual(updates, [first, second])

  const next = store.queueRefresh()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(scans.length, 3)
  scans[2].result.resolve(first)
  await next
})

test('project changes publish the active scan followed by a scan of the latest projects', async (t) => {
  const { store, scans } = fixture(t)
  const updates: Worktree[][] = []
  store.setOnChangedListener((snapshot) => updates.push(snapshot))
  const initial = store.queueRefresh()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const outdated = store.setProjects([{ mainWorktreePath: '/outdated' }])
  const latest = store.setProjects([{ mainWorktreePath: '/second' }])
  assert.equal(outdated, latest)
  assert.equal(initial, latest)
  let initialComplete = false
  void initial.then(() => {
    initialComplete = true
  })
  scans[0].result.resolve(first)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(scans.length, 2)
  assert.deepEqual(scans[1].projects, [{ mainWorktreePath: '/second' }])
  assert.deepEqual(updates, [first])
  assert.deepEqual(store.snapshot, first)
  assert.equal(initialComplete, false)

  scans[1].result.resolve(second)
  await Promise.all([initial, outdated, latest])
  assert.deepEqual(updates, [first, second])
})

test('a failed loop rejects its callers and a later request can retry', async (t) => {
  const { store, scans } = fixture(t)
  const refresh = store.queueRefresh()
  const failed = assert.rejects(refresh, /scan failed/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(store.queueRefresh(), refresh)
  scans[0].result.reject(new Error('scan failed'))
  await failed
  const retry = store.queueRefresh()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(scans.length, 2)
  scans[1].result.resolve(first)
  await retry
  assert.deepEqual(store.snapshot, first)
})

test('shutdown cancels the loop, rejects new work, and waits only for scan cleanup', async () => {
  const cleanup = deferred<Worktree[]>()
  let signal: AbortSignal | undefined
  const store = new WorktreeStore(projects, async (_projects, abortSignal) => {
    signal = abortSignal
    return cleanup.promise
  })
  const updates: Worktree[][] = []
  store.setOnChangedListener((snapshot) => updates.push(snapshot))
  const active = assert.rejects(store.queueRefresh(), /store closed/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const pending = assert.rejects(store.queueRefresh(), /store closed/)
  const closing = store.close()
  assert.equal(store.close(), closing)
  assert.equal(signal?.aborted, true)
  await assert.rejects(store.queueRefresh(), /store closed/)
  await assert.rejects(store.setProjects([]), /store closed/)
  let closed = false
  void closing.then(() => {
    closed = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closed, false)
  cleanup.resolve(first)
  await Promise.all([closing, active, pending])
  assert.deepEqual(updates, [])
  assert.deepEqual(store.snapshot, [])
})

test('shutdown before the loop starts prevents a scan', async (t) => {
  const { store, scans } = fixture(t)
  const active = assert.rejects(store.queueRefresh(), /store closed/)
  await store.close()
  await active
  assert.equal(scans.length, 0)
})
