import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  ProcessVscodeServerFactory,
  type VscodeServer,
} from '../src/server/vscode-server'
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
  const manager = new ProcessVscodeServerFactory(
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
  const servers: VscodeServer[] = []
  const errors = new Map<VscodeServer, Error[]>()
  const create = (path = worktree.path) => {
    const server = manager.create(path, (error) => {
      if (error) errors.get(server)!.push(error)
      updates.push(servers.map((server) => server.snapshot))
    })
    errors.set(server, [])
    servers.push(server)
    return server
  }
  const close = async () => {
    await Promise.all(servers.map((server) => server.stop()))
    await manager.close()
  }
  return {
    manager,
    children,
    downloaded,
    installation,
    worktree,
    updates,
    errors: (server: VscodeServer) => errors.get(server)!,
    create,
    close,
  }
}

test('preparation is required and concurrent clicks share one launch until readiness', async (t) => {
  const f = fixture()
  t.after(() => f.close())
  const preparing = f.manager.prepare('extensions')
  assert.throws(() => f.create(), /not been prepared/)
  assert.equal(f.children.length, 0)
  f.downloaded.resolve(f.installation)
  await preparing
  const server = f.create()
  server.ensure('ws://127.0.0.1:4317/rpc')
  server.ensure('ws://127.0.0.1:4317/rpc')
  assert.equal(server.snapshot.state, 'starting')
  await waitFor(() => f.children.length === 1)
  assert.equal(server.snapshot.state, 'starting')
  assert.equal(server.target, undefined)
  f.children[0].ready.resolve()
  await waitFor(() => server.snapshot.state === 'running')
  assert.equal(server.target, 'http://127.0.0.1:1234')
  assert.equal(
    server.snapshot.browserPath,
    `${vscodeBasePath(f.worktree.path)}/?tkn=test-token`,
  )
  server.ensure('ws://127.0.0.1:4317/rpc')
  assert.equal(f.children.length, 1)
  f.children[0].exit.resolve({ code: 0, signal: null })
  await waitFor(() => server.snapshot.state === 'stopped')
  assert.equal(f.errors(server).at(-1), undefined)
  assert.equal(server.target, undefined)
  assert.equal(server.snapshot.browserPath, undefined)
})

test('different worktrees start concurrently and failures remain isolated', async (t) => {
  const f = fixture()
  t.after(() => f.close())
  f.downloaded.resolve(f.installation)
  await f.manager.prepare('extensions')
  const server = f.create()
  server.ensure('ws://127.0.0.1:4317/rpc')
  const other = f.create(`${f.worktree.path}/other`)
  other.ensure('ws://127.0.0.1:4317/rpc')
  await waitFor(() => f.children.length === 2)
  assert.deepEqual(
    [server.snapshot.state, other.snapshot.state],
    ['starting', 'starting'],
  )
  f.children[1].ready.resolve()
  await waitFor(() => other.snapshot.state === 'running')
  assert.equal(server.snapshot.state, 'starting')
  f.children[0].ready.reject(new Error('First launch failed'))
  await waitFor(() => server.snapshot.state === 'stopped')
  assert.equal(f.errors(server).at(-1)?.message, 'First launch failed')
  assert.equal(other.snapshot.state, 'running')
  assert.equal(f.errors(other).at(-1), undefined)
})

test('launch and exit failures are reported to the owner without being stored in snapshots', async (t) => {
  const f = fixture()
  t.after(() => f.close())
  f.downloaded.resolve(f.installation)
  await f.manager.prepare('extensions')
  const server = f.create()
  server.ensure('ws://127.0.0.1:4317/rpc')
  f.children[0].ready.reject(new Error('Port unavailable'))
  await waitFor(() => server.snapshot.state === 'stopped')
  assert.equal(f.errors(server).at(-1)?.message, 'Port unavailable')
  assert.equal('error' in server.snapshot, false)
  server.ensure('ws://127.0.0.1:4317/rpc')
  f.children[1].ready.resolve()
  await waitFor(() => server.snapshot.state === 'running')
  f.children[1].exit.resolve({ code: 42, signal: null })
  await waitFor(() => server.snapshot.state === 'stopped')
  assert.equal(f.errors(server).length, 2)
  assert.match(f.errors(server)[1].message, /42/)
  assert.equal('error' in server.snapshot, false)
})

test('snapshots cannot mutate manager state', async (t) => {
  const f = fixture()
  t.after(() => f.close())
  f.downloaded.resolve(f.installation)
  await f.manager.prepare('extensions')
  const server = f.create()
  server.ensure('ws://127.0.0.1:4317/rpc')
  server.snapshot.state = 'running'
  assert.equal(server.snapshot.state, 'starting')
  await waitFor(() => f.children.length === 1)
  f.children[0].ready.resolve()
  await f.close()
})

test('repeated stop requests share termination and the server can restart', async (t) => {
  const f = fixture()
  t.after(() => f.close())
  f.downloaded.resolve(f.installation)
  await f.manager.prepare('extensions')
  const server = f.create()
  server.ensure('ws://127.0.0.1:4317/rpc')
  await waitFor(() => f.children.length === 1)
  f.children[0].ready.resolve()
  await waitFor(() => server.snapshot.state === 'running')
  const stopping = server.stop()
  assert.equal(server.stop(), stopping)
  await stopping
  assert.ok(f.children[0].stops() > 0)
  assert.equal(server.snapshot.state, 'stopped')
  server.ensure('ws://127.0.0.1:4317/rpc')
  await waitFor(() => f.children.length === 2)
  assert.equal(server.snapshot.state, 'starting')
})

test('a preparation failure prevents launches and is not retried by a click', async (t) => {
  let attempts = 0
  const manager = new ProcessVscodeServerFactory(
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
  await assert.rejects(manager.prepare('extensions'), /Download unavailable/)
  assert.throws(
    () => manager.create(process.cwd(), () => {}),
    /not been prepared/,
  )
  assert.equal(attempts, 1)
})

test('stopping a pending launch waits for its child and permits a clean restart', async (t) => {
  const launching = deferred<VscodeProcess>()
  const ready = deferred<VscodeConnection>()
  const exited = deferred<Awaited<VscodeProcess['exited']>>()
  let signal: AbortSignal | undefined
  let stops = 0
  let launches = 0
  const factory = new ProcessVscodeServerFactory(
    { dataDirectory: '', prepare: async () => ({ node: '', entrypoint: '' }) },
    {
      launch: async (_installation, _path, _directory, abortSignal) => {
        signal = abortSignal
        launches++
        if (launches === 1) return launching.promise
        throw new Error('Restart requested')
      },
    },
  )
  await factory.prepare('extensions')
  const errors: Error[] = []
  const server = factory.create(process.cwd(), (error) => {
    if (error) errors.push(error)
  })
  t.after(async () => {
    await server.stop()
    await factory.close()
  })
  server.ensure('ws://127.0.0.1:4317/rpc')
  const stopping = server.stop()
  assert.equal(signal?.aborted, true)
  assert.equal(server.snapshot.state, 'stopping')
  assert.throws(() => server.ensure('ws://127.0.0.1:4317/rpc'), /stopping/)
  let stopped = false
  void stopping.then(() => {
    stopped = true
  })
  await delay(5)
  assert.equal(stopped, false)
  launching.resolve({
    ready: ready.promise,
    exited: exited.promise,
    stop: async () => {
      stops++
      ready.reject(new Error('stopped'))
      exited.resolve({ code: 0, signal: null })
    },
  })
  await stopping
  assert.ok(stops > 0)
  assert.equal(server.snapshot.state, 'stopped')
  assert.equal(errors.at(-1), undefined)
  assert.equal(server.target, undefined)
  server.ensure('ws://127.0.0.1:4317/rpc')
  await waitFor(() => server.snapshot.state === 'stopped')
  assert.equal(launches, 2)
  assert.match(errors.at(-1)!.message, /Restart requested/)
  await server.stop()
  assert.equal(server.snapshot.state, 'stopped')
})

test('successful cleanup retry releases the process without reporting the old failure again', async (t) => {
  const f = fixture()
  let failure: Error | undefined = new Error('Initial cleanup failed')
  t.after(async () => {
    failure = undefined
    await f.close()
  })
  f.downloaded.resolve(f.installation)
  await f.manager.prepare('extensions')
  const server = f.create()
  server.ensure('ws://127.0.0.1:4317/rpc')
  const child = f.children[0]
  child.ready.resolve()
  await waitFor(() => server.snapshot.state === 'running')
  let attempts = 0
  const stop = child.handle.stop
  child.handle.stop = async () => {
    attempts++
    if (failure) throw failure
    await stop()
  }
  child.exit.resolve({ code: 0, signal: null })
  await waitFor(
    () => f.errors(server).at(-1)?.message === 'Initial cleanup failed',
  )
  const firstError = f.errors(server).at(-1)!
  assert.equal(server.snapshot.state, 'stopping')
  assert.throws(() => server.ensure('ws://127.0.0.1:4317/rpc'), /stopping/)

  failure = new Error('Retry cleanup failed')
  await assert.rejects(server.stop(), failure)
  const retryError = f.errors(server).at(-1)!
  assert.equal(retryError.message, failure.message)
  assert.notEqual(retryError, firstError)
  assert.equal(server.snapshot.state, 'stopping')

  failure = undefined
  await server.stop()
  assert.equal(server.snapshot.state, 'stopped')
  assert.equal(server.target, undefined)
  assert.equal(server.snapshot.browserPath, undefined)
  assert.deepEqual(f.errors(server).at(-1), retryError)
  const completedAttempts = attempts
  await server.stop()
  assert.equal(
    attempts,
    completedAttempts,
    'successful cleanup releases the retained process',
  )
  assert.deepEqual(f.errors(server).at(-1), retryError)

  server.ensure('ws://127.0.0.1:4317/rpc')
  f.children[1].ready.resolve()
  await waitFor(() => server.snapshot.state === 'running')
  assert.deepEqual(f.errors(server).at(-1), retryError)
  assert.equal(f.errors(server).length, 2)
})

test('stopping before a child is assigned still rejects a new cleanup failure', async (t) => {
  const f = fixture()
  let fail = true
  t.after(async () => {
    fail = false
    await f.close()
  })
  f.downloaded.resolve(f.installation)
  await f.manager.prepare('extensions')
  const server = f.create()
  server.ensure('ws://127.0.0.1:4317/rpc')
  const child = f.children[0]
  const stop = child.handle.stop
  const failure = new Error('Late child cleanup failed')
  child.handle.stop = async () => {
    if (fail) throw failure
    await stop()
  }
  await assert.rejects(server.stop(), failure)
  assert.equal(server.snapshot.state, 'stopping')
  const error = f.errors(server).at(-1)!
  assert.equal(error.message, failure.message)
  assert.equal(child.stops(), 0)
  fail = false
  await server.stop()
  assert.equal(
    child.stops(),
    1,
    'the late child remains owned until a successful stop',
  )
  assert.equal(server.snapshot.state, 'stopped')
  assert.deepEqual(f.errors(server).at(-1), error)
})
