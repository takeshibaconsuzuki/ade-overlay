import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { resolve } from 'node:path'
import { WorktreeStore } from '../src/server/worktree-store'
import type {
  DiscoveredWorktree,
  WorktreeDiscovery,
} from '../src/server/git-utils'
import type {
  VscodeServer,
  VscodeServerFactory,
} from '../src/server/vscode-server'
import type { VscodeServerStatus, Worktree } from '../src/shared/api'
import { ProcessVscodeServerFactory } from '../src/server/vscode-server'
import type { VscodeProcess } from '../src/server/vscode-process'
import type { Project } from '../src/server/options'
import { vscodeBasePath } from '../src/server/vscode-route'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Expected worktree update')
    await setImmediate()
  }
}

function metadata(path: string, project = '/first'): DiscoveredWorktree {
  return {
    path: resolve(path),
    basename: path.split('/').at(-1)!,
    branchName: 'main',
    mainWorktreePath: resolve(project),
    projectPath: resolve(project),
  }
}
const first = metadata('/first')
const linked = metadata('/linked')
const second = metadata('/second', '/second')

class Server implements VscodeServer {
  snapshot: VscodeServerStatus
  target: string | undefined
  stops = 0
  stopping: Promise<void> = Promise.resolve()
  constructor(
    path: string,
    private readonly changed: (error?: Error) => void,
  ) {
    this.snapshot = { path, state: 'stopped' }
  }
  ensure(): void {
    if (this.snapshot.state === 'stopping')
      throw new Error('VS Code server is stopping')
    this.snapshot.state = 'running'
    this.target = 'http://127.0.0.1:1234'
    this.changed()
  }
  fail(error: Error): void {
    this.changed(error)
  }
  async stop(): Promise<void> {
    this.stops++
    this.snapshot.state = 'stopping'
    this.target = undefined
    this.changed()
    await this.stopping
    this.snapshot.state = 'stopped'
    this.changed()
  }
}

class Servers implements VscodeServerFactory {
  created: Server[] = []
  async prepare(): Promise<void> {}
  async close(): Promise<void> {}
  create(path: string, changed: (error?: Error) => void): Server {
    const server = new Server(path, changed)
    this.created.push(server)
    return server
  }
}

class Discovery implements WorktreeDiscovery {
  found = [first, linked]
  scans: Project[][] = []
  failure: Error | undefined
  removedBranches: string[] = []
  branchRemovalError: Error | undefined
  async removeBranch(_main: string, branchName: string): Promise<void> {
    if (this.branchRemovalError) throw this.branchRemovalError
    this.removedBranches.push(branchName)
  }
  removed: string[] = []
  removing: string[] = []
  pendingRemovals = new Map<string, ReturnType<typeof deferred<void>>>()
  removalError: Error | undefined
  pending: ReturnType<typeof deferred<DiscoveredWorktree[]>> | undefined
  signal: AbortSignal | undefined
  async scan(
    projects: Project[],
    signal: AbortSignal,
  ): Promise<DiscoveredWorktree[]> {
    this.scans.push(projects)
    this.signal = signal
    if (this.pending) return this.pending.promise
    if (this.failure) throw this.failure
    return this.found
  }
  async remove(_main: string, path: string): Promise<void> {
    this.removing.push(path)
    await this.pendingRemovals.get(path)?.promise
    if (this.removalError) throw this.removalError
    this.removed.push(path)
    this.found = this.found.filter((entry) => entry.path !== path)
  }
}

function fixture(
  t: TestContext,
  projects = [{ mainWorktreePath: first.path }],
) {
  const servers = new Servers()
  const discovery = new Discovery()
  const store = new WorktreeStore(projects, servers, discovery)
  t.after(async () => {
    for (const gate of discovery.pendingRemovals.values()) gate.resolve()
    for (const server of servers.created) server.stopping = Promise.resolve()
    await store.close()
  })
  return { store, servers, discovery }
}

test('refresh preserves owned servers and publishes metadata and status together', async (t) => {
  const { store, servers, discovery } = fixture(t)
  await store.queueRefresh()
  assert.equal(servers.created.length, 0)
  const snapshots: Worktree[][] = []
  store.setOnChangedListener((next) => snapshots.push(next))
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  const server = servers.created[0]
  discovery.found = [first, { ...linked, branchName: 'feature' }]
  await store.queueRefresh()
  assert.equal(servers.created.length, 1)
  assert.equal(server.snapshot.state, 'running')
  assert.equal(store.snapshot[1].branchName, 'feature')
  assert.equal(store.snapshot[1].vscode.state, 'running')
  assert.equal(store.getTarget(vscodeBasePath(linked.path)), server.target)
  assert.equal(snapshots.at(-1)?.[1].vscode.state, 'running')
  store.snapshot[0].basename = 'mutated'
  assert.equal(store.snapshot[0].basename, 'first')
})

test('failed and inconsistent discovery preserve the complete current registry', async (t) => {
  const { store, servers, discovery } = fixture(t)
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  const before = store.snapshot
  discovery.failure = new Error('Git unavailable')
  await assert.rejects(store.queueRefresh(), /Git unavailable/)
  assert.deepEqual(store.snapshot, before)
  discovery.failure = undefined
  discovery.found = [first]
  await assert.rejects(store.queueRefresh(), /disappeared outside ADE/)
  assert.deepEqual(store.snapshot, before)
  assert.equal(servers.created[0].stops, 0)
  discovery.found = [first, linked]
  await store.queueRefresh()
})

test('project removal stops owned servers even if remaining discovery fails', async (t) => {
  const { store, servers, discovery } = fixture(t, [
    { mainWorktreePath: first.path },
    { mainWorktreePath: second.path },
  ])
  discovery.found = [first, linked, second]
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  store.ensureVscodeServer(second.path, 'ws://127.0.0.1:4317/rpc')
  discovery.failure = new Error('remaining scan failed')
  await assert.rejects(
    store.setProjects([{ mainWorktreePath: second.path }]),
    /remaining scan failed/,
  )
  assert.equal(servers.created[0].snapshot.state, 'stopped')
  assert.equal(servers.created[1].snapshot.state, 'running')
  assert.deepEqual(
    store.snapshot.map((entry) => entry.path),
    [second.path],
  )
  assert.equal(store.snapshot[0].vscode.state, 'running')
  assert.equal(store.getTarget(vscodeBasePath(linked.path)), undefined)
  assert.throws(
    () => store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc'),
    /Unknown worktree/,
  )
})

test('project removal publishes immediately and cleanup failure does not block configuration or discovery', async (t) => {
  const { store, servers, discovery } = fixture(t, [
    { mainWorktreePath: first.path },
    { mainWorktreePath: second.path },
  ])
  discovery.found = [first, linked, second]
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  const stopping = deferred<void>()
  t.after(() => stopping.resolve())
  servers.created[0].stopping = stopping.promise
  const snapshots: Worktree[][] = []
  store.setOnChangedListener((next) => snapshots.push(next))
  discovery.found = [second]
  let removed = false
  const removal = store
    .setProjects([{ mainWorktreePath: second.path }])
    .then(() => {
      removed = true
    })
  await waitFor(() => removed)
  await removal
  assert.deepEqual(
    snapshots[0].map((entry) => entry.path),
    [second.path],
  )
  assert.equal(servers.created[0].snapshot.state, 'stopping')
  assert.equal(store.getTarget(vscodeBasePath(linked.path)), undefined)
  assert.throws(
    () => store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc'),
    /Unknown worktree/,
  )

  const third = metadata('/third', '/third')
  discovery.found = [second, third]
  await store.setProjects([
    { mainWorktreePath: second.path },
    { mainWorktreePath: third.path },
  ])
  store.ensureVscodeServer(second.path, 'ws://127.0.0.1:4317/rpc')
  await store.queueRefresh()
  stopping.reject(new Error('Unable to terminate process'))
  await setImmediate()
  discovery.found = [{ ...second, branchName: 'updated' }, third]
  await store.queueRefresh()
  assert.deepEqual(
    store.snapshot.map((entry) => entry.path),
    [second.path, third.path],
  )
  assert.equal(store.snapshot[0].branchName, 'updated')
  assert.equal(store.snapshot[0].vscode.state, 'running')
  assert.equal(servers.created[0].stops, 1)
})

test('stopping keeps the entry restartable; deletion waits for stopping and only unregisters on success', async (t) => {
  const { store, servers, discovery } = fixture(t)
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  const server = servers.created[0]
  assert.equal(store.stopVscodeServer(linked.path), undefined)
  await waitFor(() => store.snapshot[1].vscode.state === 'stopped')
  assert.equal(store.snapshot.length, 2)
  assert.equal(store.snapshot[1].vscode.state, 'stopped')
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  discovery.removalError = new Error('dirty worktree')
  assert.equal(store.deleteWorktree(linked.path), undefined)
  await waitFor(() => !store.snapshot[1].deleting)
  assert.match(store.snapshot[1].error!.message, /dirty worktree/)
  store.clearWorktreeError(linked.path, store.snapshot[1].error!.id)
  assert.equal(store.snapshot[1].error, undefined)
  assert.equal(store.snapshot.length, 2)
  assert.equal(server.snapshot.state, 'stopped')
  discovery.removalError = undefined
  const stopped = deferred<void>()
  server.stopping = stopped.promise
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  store.deleteWorktree(linked.path)
  assert.equal(store.snapshot[1].deleting, true)
  await setImmediate()
  assert.equal(discovery.removed.length, 0)
  assert.equal(store.getTarget(vscodeBasePath(linked.path)), undefined)
  assert.throws(
    () => store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc'),
    /being deleted/,
  )
  stopped.resolve()
  await waitFor(() => store.snapshot.length === 1)
  assert.deepEqual(discovery.removed, [linked.path])
  assert.deepEqual(
    store.snapshot.map((entry) => entry.path),
    [first.path],
  )
  assert.equal(server.snapshot.state, 'stopped')
  assert.throws(
    () => store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc'),
    /Unknown worktree/,
  )
  await store.queueRefresh()
  assert.throws(
    () => store.deleteWorktree(first.path),
    /main worktree cannot be deleted/,
  )
})

test('refresh requests coalesce while a scan is running', async (t) => {
  const { store, discovery } = fixture(t)
  discovery.pending = deferred<DiscoveredWorktree[]>()
  const initial = store.queueRefresh()
  await setImmediate()
  const next = store.queueRefresh()
  assert.equal(initial, next)
  for (let i = 0; i < 20; i++) assert.equal(store.queueRefresh(), next)
  const pending = discovery.pending
  discovery.pending = undefined
  pending.resolve(discovery.found)
  await initial
  assert.equal(discovery.scans.length, 2)
})

test('serialized project removal cannot be undone by an earlier scan', async (t) => {
  const { store, servers, discovery } = fixture(t)
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  discovery.pending = deferred<DiscoveredWorktree[]>()
  const refresh = store.queueRefresh()
  await setImmediate()
  const removed = store.setProjects([])
  const pending = discovery.pending
  discovery.pending = undefined
  discovery.found = []
  pending.resolve([first, linked])
  await Promise.all([refresh, removed])
  assert.deepEqual(store.snapshot, [])
  assert.equal(servers.created[0].snapshot.state, 'stopped')
})

test('duplicate project configuration is rejected without touching current ownership', async (t) => {
  const { store, discovery } = fixture(t)
  await store.queueRefresh()
  const before = store.snapshot
  await assert.rejects(
    store.setProjects([
      { mainWorktreePath: first.path },
      { mainWorktreePath: first.path },
    ]),
    /Duplicate project/,
  )
  assert.deepEqual(store.snapshot, before)
  assert.equal(discovery.scans.length, 1)
})

test('shutdown cancels discovery, waits for cleanup, and prevents queued work', async (t) => {
  const { store, discovery } = fixture(t)
  discovery.pending = deferred<DiscoveredWorktree[]>()
  const active = assert.rejects(store.queueRefresh(), /store closed/)
  await setImmediate()
  const queued = assert.rejects(store.setProjects([]), /store closed/)
  const closing = store.close()
  assert.equal(store.close(), closing)
  assert.equal(discovery.signal?.aborted, true)
  let closed = false
  void closing.then(() => {
    closed = true
  })
  await setImmediate()
  assert.equal(closed, false)
  discovery.pending.resolve([first, linked])
  await Promise.all([active, queued, closing])
  assert.deepEqual(store.snapshot, [])
  await assert.rejects(store.queueRefresh(), /store closed/)
  assert.throws(
    () => store.ensureVscodeServer(first.path, 'ws://127.0.0.1:4317/rpc'),
    /store closed/,
  )
})

test('a slow stop or deletion does not block other worktrees or discovery', async (t) => {
  const { store, servers, discovery } = fixture(t)
  const another = metadata('/another')
  discovery.found = [first, linked, another]
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  const stopped = deferred<void>()
  servers.created[0].stopping = stopped.promise
  const removed = deferred<void>()
  discovery.pendingRemovals.set(linked.path, removed)
  // Always release the gates, including when an assertion fails.
  t.after(() => {
    stopped.resolve()
    removed.resolve()
  })
  assert.equal(store.stopVscodeServer(linked.path), undefined)
  assert.equal(store.snapshot[1].vscode.state, 'stopping')
  assert.throws(
    () => store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc'),
    /stopping/,
  )
  store.ensureVscodeServer(first.path, 'ws://127.0.0.1:4317/rpc')
  store.ensureVscodeServer(another.path, 'ws://127.0.0.1:4317/rpc')
  assert.equal(store.snapshot[0].vscode.state, 'running')
  assert.equal(store.snapshot[2].vscode.state, 'running')
  store.deleteWorktree(linked.path)
  store.deleteWorktree(linked.path)
  stopped.resolve()
  await waitFor(() => discovery.removing.includes(linked.path))
  assert.equal(store.snapshot[1].vscode.state, 'stopped')
  assert.equal(store.snapshot[1].deleting, true)
  assert.throws(
    () => store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc'),
    /being deleted/,
  )
  store.stopVscodeServer(first.path)
  store.deleteWorktree(another.path)
  await waitFor(
    () =>
      store.snapshot.length === 2 &&
      store.snapshot[0].vscode.state === 'stopped',
  )
  await store.queueRefresh()
  assert.equal(store.snapshot[1].deleting, true)
  store.ensureVscodeServer(first.path, 'ws://127.0.0.1:4317/rpc')
  assert.equal(store.snapshot[0].vscode.state, 'running')
  assert.deepEqual(discovery.removing, [linked.path, another.path])
  removed.resolve()
  await waitFor(() => store.snapshot.length === 1)
})

for (const scanIncludesDeleted of [true, false]) {
  test(`discovery rechecks deletion before publishing (scan includes deleted: ${scanIncludesDeleted})`, async (t) => {
    const { store, discovery } = fixture(t)
    await store.queueRefresh()
    discovery.pending = deferred<DiscoveredWorktree[]>()
    const scanning = store.queueRefresh()
    await setImmediate()
    store.deleteWorktree(linked.path)
    await waitFor(() => store.snapshot.length === 1)
    discovery.pending.resolve(scanIncludesDeleted ? [first, linked] : [first])
    await scanning
    assert.deepEqual(
      store.snapshot.map((entry) => entry.path),
      [first.path],
    )
  })
}

test('discovery tolerates a directory disappearing during an accepted deletion', async (t) => {
  const { store, discovery } = fixture(t)
  await store.queueRefresh()
  const removed = deferred<void>()
  discovery.pendingRemovals.set(linked.path, removed)
  t.after(() => removed.resolve())
  store.deleteWorktree(linked.path)
  await waitFor(() => discovery.removing.length === 1)
  discovery.found = [first]
  await store.queueRefresh()
  assert.equal(store.snapshot[1].deleting, true)
  removed.resolve()
  await waitFor(() => store.snapshot.length === 1)
})

test('shutdown awaits accepted deletion and suppresses late snapshots', async (t) => {
  const { store, discovery } = fixture(t)
  await store.queueRefresh()
  const removed = deferred<void>()
  discovery.pendingRemovals.set(linked.path, removed)
  t.after(() => removed.resolve())
  const snapshots: Worktree[][] = []
  store.setOnChangedListener((next) => snapshots.push(next))
  store.deleteWorktree(linked.path)
  await waitFor(() => discovery.removing.length === 1)
  let closed = false
  const closing = store.close().then(() => {
    closed = true
  })
  const count = snapshots.length
  await setImmediate()
  assert.equal(closed, false)
  removed.resolve()
  await closing
  assert.equal(snapshots.length, count)
})

test('shutdown awaits server termination after project removal', async (t) => {
  const stopping = deferred<void>()
  t.after(() => stopping.resolve())
  const { store, servers, discovery } = fixture(t)
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  servers.created[0].stopping = stopping.promise
  discovery.found = []
  await store.setProjects([])
  assert.equal(store.snapshot.length, 0)
  let closed = false
  const closing = store.close().then(() => {
    closed = true
  })
  await setImmediate()
  assert.equal(closed, false)
  stopping.resolve()
  await closing
  assert.equal(servers.created[0].snapshot.state, 'stopped')
})

test('shutdown awaits a removed project deletion even when its server cleanup fails', async (t) => {
  const deleting = deferred<void>()
  const stopping = deferred<void>()
  t.after(() => {
    deleting.resolve()
    stopping.resolve()
  })
  const { store, servers, discovery } = fixture(t)
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  discovery.pendingRemovals.set(linked.path, deleting)
  store.deleteWorktree(linked.path)
  await waitFor(() => discovery.removing.length === 1)
  servers.created[0].stopping = stopping.promise
  discovery.found = []
  await store.setProjects([])
  assert.equal(store.snapshot.length, 0)
  stopping.reject(new Error('Unable to terminate process'))
  await setImmediate()
  let closed = false
  const closing = store.close().then(() => {
    closed = true
  })
  await setImmediate()
  assert.equal(closed, false)
  deleting.resolve()
  await closing
  assert.deepEqual(discovery.removed, [linked.path])
})

for (const removal of ['deletion', 'project removal', 'shutdown'] as const) {
  test(`${removal} blocks new starts and cleans up a pending launch`, async (t) => {
    const launching = deferred<VscodeProcess>()
    const terminated = deferred<void>()
    let launchSignal: AbortSignal | undefined
    let launches = 0
    let stops = 0
    const factory = new ProcessVscodeServerFactory(
      {
        dataDirectory: '',
        prepare: async () => ({ node: '', entrypoint: '' }),
      },
      {
        launch: async (_installation, _path, _directory, signal) => {
          launches++
          launchSignal = signal
          return launching.promise
        },
      },
    )
    await factory.prepare('extensions')
    const discovery = new Discovery()
    const store = new WorktreeStore(
      [{ mainWorktreePath: first.path }],
      factory,
      discovery,
    )
    const child: VscodeProcess = {
      ready: Promise.resolve({ port: 1234, token: 'test' }),
      exited: Promise.resolve({ code: 0, signal: null }),
      stop: async () => {
        stops++
        await terminated.promise
      },
    }
    t.after(async () => {
      launching.resolve(child)
      terminated.resolve()
      await store.close()
      await factory.close()
    })
    await store.queueRefresh()
    store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
    let complete = false
    let completion: Promise<void>
    if (removal === 'deletion') {
      store.deleteWorktree(linked.path)
      completion = waitFor(
        () => !store.snapshot.some((entry) => entry.path === linked.path),
      )
    } else if (removal === 'project removal') {
      discovery.found = []
      completion = store.setProjects([])
    } else {
      completion = store.close()
    }
    void completion.then(() => {
      complete = true
    })
    await setImmediate()
    assert.equal(launchSignal?.aborted, true)
    assert.throws(
      () => store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc'),
      /being deleted|Unknown worktree|store closed/,
    )
    assert.equal(complete, removal === 'project removal')
    launching.resolve(child)
    await waitFor(() => stops > 0)
    assert.equal(complete, removal === 'project removal')
    assert.equal(
      store.snapshot.some((entry) => entry.path === linked.path),
      removal !== 'project removal',
    )
    assert.equal(discovery.removed.length, 0)
    terminated.resolve()
    await completion
    assert.equal(launches, 1)
    assert.equal(
      store.snapshot.some((entry) => entry.path === linked.path),
      false,
    )
    assert.throws(
      () => store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc'),
      /Unknown worktree|store closed/,
    )
  })
}

test('a failed stop retains ownership and prevents Git deletion', async (t) => {
  const { store, servers, discovery } = fixture(t)
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  const failure = deferred<void>()
  servers.created[0].stopping = failure.promise
  store.deleteWorktree(linked.path)
  await setImmediate()
  failure.reject(new Error('Unable to terminate process'))
  await waitFor(() => !store.snapshot[1].deleting)
  assert.equal(store.snapshot[1].path, linked.path)
  assert.match(store.snapshot[1].error!.message, /Unable to terminate/)
  assert.deepEqual(discovery.removing, [])
  servers.created[0].stopping = Promise.resolve()
  store.deleteWorktree(linked.path)
  await waitFor(() => store.snapshot.length === 1)
  assert.deepEqual(discovery.removed, [linked.path])
})

test('one worktree error retains the latest server or deletion failure until explicit dismissal', async (t) => {
  const { store, servers, discovery } = fixture(t)
  await store.queueRefresh()
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  const server = servers.created[0]
  server.fail(new Error('Server failed'))
  const serverError = store.snapshot[1].error!
  assert.equal(serverError.message, 'Server failed')
  assert.equal('error' in store.snapshot[1].vscode, false)
  store.stopVscodeServer(linked.path)
  await waitFor(() => store.snapshot[1].vscode.state === 'stopped')
  assert.deepEqual(store.snapshot[1].error, serverError)
  store.ensureVscodeServer(linked.path, 'ws://127.0.0.1:4317/rpc')
  assert.deepEqual(store.snapshot[1].error, serverError)
  await store.queueRefresh()
  assert.deepEqual(store.snapshot[1].error, serverError)

  discovery.removalError = new Error('Dirty worktree')
  store.deleteWorktree(linked.path)
  assert.deepEqual(store.snapshot[1].error, serverError)
  await waitFor(() => !store.snapshot[1].deleting)
  const deletionError = store.snapshot[1].error!
  assert.equal(deletionError.message, 'Dirty worktree')
  assert.notEqual(deletionError.id, serverError.id)
  store.clearWorktreeError(linked.path, serverError.id)
  assert.deepEqual(store.snapshot[1].error, deletionError)
  server.fail(new Error('Another server failure'))
  const latest = store.snapshot[1].error!
  assert.equal(latest.message, 'Another server failure')
  store.clearWorktreeError(linked.path, deletionError.id)
  assert.deepEqual(store.snapshot[1].error, latest)
  store.clearWorktreeError(linked.path, latest.id)
  assert.equal(store.snapshot[1].error, undefined)
  store.snapshot[1].error = serverError
  assert.equal(store.snapshot[1].error, undefined)
})

test('combined deletion removes the branch only after the worktree and preserves idempotence', async (t) => {
  const { store, discovery } = fixture(t)
  await store.queueRefresh()
  const removing = deferred<void>()
  discovery.pendingRemovals.set(linked.path, removing)
  store.deleteWorktree(linked.path, linked.branchName!)
  store.deleteWorktree(linked.path, linked.branchName!)
  await waitFor(() => discovery.removing.length === 1)
  assert.deepEqual(discovery.removedBranches, [])
  removing.resolve()
  await waitFor(() => store.snapshot.length === 1)
  assert.deepEqual(discovery.removedBranches, [linked.branchName])
})

test('combined deletion keeps branch failures visible on the main worktree after removal', async (t) => {
  const { store, discovery } = fixture(t)
  await store.queueRefresh()
  discovery.branchRemovalError = new Error('Branch is not fully merged')
  store.deleteWorktree(linked.path, linked.branchName!)
  await waitFor(() => store.snapshot.length === 1)
  assert.match(
    store.snapshot[0].error!.message,
    /was removed, but branch main could not be deleted: Branch is not fully merged/,
  )
  await store.queueRefresh()
  assert.equal(store.snapshot.length, 1)
  store.clearWorktreeError(first.path, store.snapshot[0].error!.id)
  assert.equal(store.snapshot[0].error, undefined)
})

test('failed worktree removal never deletes its branch', async (t) => {
  const { store, discovery } = fixture(t)
  await store.queueRefresh()
  discovery.removalError = new Error('Dirty worktree')
  store.deleteWorktree(linked.path, linked.branchName!)
  await waitFor(() => !store.snapshot[1].deleting)
  assert.deepEqual(discovery.removedBranches, [])
  assert.match(store.snapshot[1].error!.message, /Dirty worktree/)
})

test('combined deletion rejects main worktrees, detached HEADs and changed branches', async (t) => {
  const { store, discovery } = fixture(t)
  await store.queueRefresh()
  assert.throws(
    () => store.deleteWorktree(first.path, first.branchName!),
    /main worktree cannot be deleted/,
  )
  assert.throws(
    () => store.deleteWorktree(linked.path, 'old-branch'),
    /branch changed/,
  )
  discovery.found = [first, { ...linked, branchName: null }]
  await store.queueRefresh()
  assert.throws(
    () => store.deleteWorktree(linked.path, linked.branchName!),
    /branch changed/,
  )
  assert.deepEqual(discovery.removing, [])
})
