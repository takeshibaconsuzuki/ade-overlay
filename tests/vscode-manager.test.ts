import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ProcessVscodeServerManager } from '../src/server/vscode-manager'
import type { VscodeServerStatus } from '../src/shared/api'
import type {
  VscodeConnection,
  VscodeProcess,
} from '../src/server/vscode-process'
import { vscodeBasePath } from '../src/server/vscode-route'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      'Expected lifecycle transition did not arrive',
    )
    await delay(5)
  }
}

function fixture() {
  const children: ReturnType<typeof child>[] = []
  function child() {
    const readiness = deferred<VscodeConnection>()
    const ready = {
      ...readiness,
      resolve: () => readiness.resolve({ port: 1234, token: 'test-token' }),
    }
    const exit = deferred<Awaited<VscodeProcess['exited']>>()
    let stops = 0
    const handle: VscodeProcess = {
      ready: ready.promise,
      exited: exit.promise,
      stop: async () => {
        stops++
        ready.reject(new Error('stopped'))
        exit.resolve({ code: 0, signal: null })
      },
    }
    return { ready, exit, handle, stops: () => stops }
  }
  const installation = { node: 'node', entrypoint: 'server' }
  const downloaded = deferred<typeof installation>()
  const manager = new ProcessVscodeServerManager(
    { dataDirectory: '', prepare: () => downloaded.promise },
    {
      launch: async () => {
        const next = child()
        children.push(next)
        return next.handle
      },
    },
  )
  const worktree = { path: process.cwd(), basename: 'repo', branchName: 'main' }
  const updates: VscodeServerStatus[][] = []
  manager.setOnChangedListener((next) => updates.push(next))
  return { manager, children, downloaded, installation, worktree, updates }
}

test('preparation is required and concurrent clicks share one launch until readiness', async (t) => {
  const f = fixture()
  t.after(() => f.manager.close())
  const preparing = f.manager.prepare()
  assert.throws(() => f.manager.ensure(f.worktree.path), /not been prepared/)
  assert.equal(f.children.length, 0)
  f.downloaded.resolve(f.installation)
  await preparing
  f.manager.ensure(f.worktree.path)
  f.manager.ensure(f.worktree.path)
  assert.equal(f.manager.snapshot[0].state, 'starting')
  await waitFor(() => f.children.length === 1)
  assert.equal(f.manager.snapshot[0].state, 'starting')
  assert.equal(f.manager.getTarget(vscodeBasePath(f.worktree.path)), undefined)
  f.children[0].ready.resolve()
  await waitFor(() => f.manager.snapshot[0].state === 'running')
  assert.equal(
    f.manager.getTarget(vscodeBasePath(f.worktree.path)),
    'http://127.0.0.1:1234',
  )
  assert.equal(
    f.manager.snapshot[0].browserPath,
    `${vscodeBasePath(f.worktree.path)}/?tkn=test-token`,
  )
  f.manager.ensure(f.worktree.path)
  assert.equal(f.children.length, 1)
  f.children[0].exit.resolve({ code: 0, signal: null })
  await waitFor(() => f.manager.snapshot[0].state === 'stopped')
  assert.equal(f.manager.snapshot[0].error, undefined)
  assert.equal(f.manager.getTarget(vscodeBasePath(f.worktree.path)), undefined)
  assert.equal(f.manager.snapshot[0].browserPath, undefined)
})

test('different worktrees start concurrently and failures remain isolated', async (t) => {
  const f = fixture()
  t.after(() => f.manager.close())
  f.downloaded.resolve(f.installation)
  await f.manager.prepare()
  f.manager.ensure(f.worktree.path)
  f.manager.ensure(`${f.worktree.path}/other`)
  await waitFor(() => f.children.length === 2)
  assert.deepEqual(
    f.manager.snapshot.map(({ state }) => state),
    ['starting', 'starting'],
  )
  f.children[1].ready.resolve()
  await waitFor(() => f.manager.snapshot[1].state === 'running')
  assert.equal(f.manager.snapshot[0].state, 'starting')
  f.children[0].ready.reject(new Error('First launch failed'))
  await waitFor(() => f.manager.snapshot[0].state === 'stopped')
  assert.equal(f.manager.snapshot[0].error?.message, 'First launch failed')
  assert.equal(f.manager.snapshot[1].state, 'running')
  assert.equal(f.manager.snapshot[1].error, undefined)
})

test('failures can be dismissed without launching, and stale dismissals preserve newer errors', async (t) => {
  const f = fixture()
  t.after(() => f.manager.close())
  f.downloaded.resolve(f.installation)
  await f.manager.prepare()
  f.manager.ensure(f.worktree.path)
  await waitFor(() => f.children.length === 1)
  f.children[0].ready.reject(new Error('Port unavailable'))
  await waitFor(() => f.manager.snapshot[0].state === 'stopped')
  const first = f.manager.snapshot[0].error!
  assert.equal(first.message, 'Port unavailable')
  f.manager.clearError(f.worktree.path, first.id)
  assert.equal(f.manager.snapshot[0].error, undefined)
  assert.equal(f.children.length, 1)
  f.manager.ensure(f.worktree.path)
  await waitFor(() => f.children.length === 2)
  f.children[1].ready.resolve()
  await waitFor(() => f.manager.snapshot[0].state === 'running')
  f.children[1].exit.resolve({ code: 42, signal: null })
  await waitFor(() => f.manager.snapshot[0].state === 'stopped')
  const second = f.manager.snapshot[0].error!
  assert.match(second.message, /42/)
  f.manager.clearError(f.worktree.path, first.id)
  assert.deepEqual(f.manager.snapshot[0].error, second)
})

test('snapshots cannot mutate manager state', async (t) => {
  const f = fixture()
  t.after(() => f.manager.close())
  f.downloaded.resolve(f.installation)
  await f.manager.prepare()
  f.manager.ensure(f.worktree.path)
  f.manager.snapshot[0].state = 'running'
  assert.equal(f.manager.snapshot[0].state, 'starting')
  await waitFor(() => f.children.length === 1)
  f.children[0].ready.resolve()
  await f.manager.close()
})

test('shutdown waits for process termination and is idempotent', async (t) => {
  const f = fixture()
  t.after(() => f.manager.close())
  f.downloaded.resolve(f.installation)
  await f.manager.prepare()
  f.manager.ensure(f.worktree.path)
  await waitFor(() => f.children.length === 1)
  f.children[0].ready.resolve()
  await waitFor(() => f.manager.snapshot[0].state === 'running')
  await f.manager.close()
  assert.ok(f.children[0].stops() > 0)
  assert.equal(f.manager.close(), f.manager.close())
  assert.throws(() => f.manager.ensure(f.worktree.path), /closed/)
})

test('a preparation failure prevents launches and is not retried by a click', async (t) => {
  let attempts = 0
  const manager = new ProcessVscodeServerManager(
    {
      dataDirectory: '',
      prepare: async () => {
        attempts++
        throw new Error('Download unavailable')
      },
    },
    {
      launch: async () => {
        throw new Error('Unexpected launch')
      },
    },
  )
  t.after(() => manager.close())
  await assert.rejects(manager.prepare(), /Download unavailable/)
  assert.throws(() => manager.ensure(process.cwd()), /not been prepared/)
  assert.equal(attempts, 1)
  assert.deepEqual(manager.snapshot, [])
})
