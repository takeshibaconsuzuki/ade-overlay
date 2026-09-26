import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { stringify } from 'yaml'
import { CompanionClient } from '../src/main/companion-client.ts'
import { loadServerConfig, parseServerArgs } from '../src/server/config.ts'
import { startCompanionServer } from '../src/server/server.ts'
import { WorktreeStore } from '../src/server/worktrees.ts'
import {
  parseClientMessage,
  parseServerMessage,
  type WorktreeUpdate,
} from '../src/shared/companion.ts'

const execute = promisify(execFile)
async function git(project: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', project, ...args], {
    windowsHide: true,
  })
  return stdout.trim()
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ade-worktrees-')))
  t.after(async () => {
    // Only recursively remove this test's freshly allocated temporary directory.
    const temp = await realpath(tmpdir())
    assert.ok(resolve(root).startsWith(resolve(temp) + sep))
    assert.ok(root.split(sep).at(-1)?.startsWith('ade-worktrees-'))
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  })
  const makeProject = async (name: string) => {
    const path = join(root, name)
    await mkdir(path)
    await git(path, 'init', '--initial-branch=main')
    await git(
      path,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--no-gpg-sign',
      '--allow-empty',
      '-m',
      'Initial',
    )
    return path
  }
  return { root, makeProject }
}

async function connectClient(
  t: TestContext,
  url: string,
): Promise<CompanionClient> {
  const client = new CompanionClient({
    url,
    requestTimeoutMs: 10_000,
    reconnectDelayMs: 20,
  })
  t.after(() => client.stop())
  const ready = new Promise<void>((resolve) =>
    client.on('status', (status) => {
      if (status.state === 'connected') resolve()
    }),
  )
  client.connect()
  await ready
  return client
}

test('config arguments and YAML validate projects and resolve home/relative paths', async (t) => {
  const { root } = await fixture(t)
  const path = join(root, 'server.yaml')
  assert.deepEqual(parseServerArgs([]), { configPath: undefined })
  assert.deepEqual(parseServerArgs(['--config', path]), { configPath: path })
  assert.deepEqual(parseServerArgs([`--config=${path}`]), { configPath: path })
  for (const args of [
    ['--config'],
    ['--config='],
    ['--unknown'],
    ['file.yaml'],
  ])
    assert.throws(() => parseServerArgs(args))
  await writeFile(
    path,
    stringify({ projects: ['./relative repo', '~/project'] }),
  )
  assert.deepEqual(await loadServerConfig(path), {
    projects: [join(root, 'relative repo'), join(homedir(), 'project')],
  })
  for (const source of [
    '',
    'projects: nope',
    'projects: [null]',
    'projects: [42]',
    'projects: [""]',
    'projects: [',
    'projects: []\nprojects: []',
  ]) {
    await writeFile(path, source)
    await assert.rejects(loadServerConfig(path), /Invalid config/)
  }
  await assert.rejects(
    loadServerConfig(join(root, 'missing.yaml')),
    /Could not read config/,
  )
  await writeFile(path, 'projects: []')
  assert.deepEqual(await loadServerConfig(path), { projects: [] })
})

test('startup cache covers all repositories and sync list stays cached until refresh', async (t) => {
  const { root, makeProject } = await fixture(t)
  const first = await makeProject('first project')
  const second = await makeProject('second')
  const linked = join(root, 'existing ü worktree')
  await git(first, 'worktree', 'add', '-b', 'existing', linked)
  await git(first, 'worktree', 'lock', '--reason', 'test lock', linked)
  const detached = join(root, 'detached')
  await git(second, 'worktree', 'add', '--detach', detached)
  const store = await WorktreeStore.open([first, second, first])
  const snapshot = store.list()
  assert.equal(snapshot.worktrees.length, 4)
  assert.deepEqual(snapshot.projects, [first, second])
  assert.equal(snapshot.worktrees.filter((entry) => entry.main).length, 2)
  assert.equal(
    snapshot.worktrees.find((entry) => entry.path === linked)?.locked,
    true,
  )
  assert.equal(
    snapshot.worktrees.find((entry) => entry.path === detached)?.branch,
    null,
  )
  snapshot.worktrees.length = 0
  assert.equal(store.list().worktrees.length, 4)
  await git(second, 'worktree', 'add', '-b', 'external', join(root, 'external'))
  assert.equal(store.list().worktrees.length, 4)
  assert.equal((await store.refresh()).worktrees.length, 5)
  await assert.rejects(WorktreeStore.open([linked]), /main worktree root/)
  await assert.rejects(WorktreeStore.open([root]))
})

test('async mutations preserve cache on failure, serialize conflicts and protect dirty/main/locked trees', async (t) => {
  const { root, makeProject } = await fixture(t)
  const project = await makeProject('project')
  const store = await WorktreeStore.open([project])
  const input = {
    project,
    baseBranch: 'main',
    branch: 'feature/test',
    path: '../new worktree',
  }
  const changes: string[] = []
  store.on('update', (update) => changes.push(update.change))
  const results = await Promise.allSettled([
    store.create(input),
    store.create(input),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  const path = join(root, 'new worktree')
  assert.equal(
    store.list().worktrees.find((entry) => entry.path === path)?.branch,
    input.branch,
  )
  for (const fields of [
    { ...input, project: root },
    { ...input, branch: '-bad' },
    { ...input, branch: 'bad name' },
    { ...input, branch: 'bad-base', baseBranch: '--help' },
  ])
    await assert.rejects(store.create(fields))
  await assert.rejects(
    store.delete({ project, path: project }),
    /main worktree/,
  )
  await assert.rejects(
    store.delete({ project, path: root }),
    /not in the cache/,
  )
  await writeFile(join(path, 'untracked.txt'), 'Keep me')
  await assert.rejects(store.delete({ project, path }), /untracked|modified/i)
  assert.equal(await readFile(join(path, 'untracked.txt'), 'utf8'), 'Keep me')
  await rm(join(path, 'untracked.txt'))
  await git(project, 'worktree', 'lock', path)
  // Even a lock made after the last scan must be honored by Git.
  await assert.rejects(store.delete({ project, path }), /locked/i)
  await store.refresh()
  await assert.rejects(store.delete({ project, path }), /Unlock/)
  await git(project, 'worktree', 'unlock', path)
  await store.refresh()
  await store.delete({ project, path })
  assert.equal(store.list().worktrees.length, 1)
  assert.ok(
    await git(project, 'rev-parse', '--verify', 'refs/heads/feature/test'),
  )
  assert.deepEqual(changes, ['created', 'refreshed', 'refreshed', 'deleted'])
})

test(
  'first connection sees populated cache; create/delete/refresh broadcast to every client',
  { timeout: 30_000 },
  async (t) => {
    const { root, makeProject } = await fixture(t)
    const project = await makeProject('project')
    const configPath = join(root, 'server.yaml')
    await writeFile(configPath, stringify({ projects: [project] }))
    const server = await startCompanionServer({ port: 0, configPath })
    t.after(() => server.close())
    const first = await connectClient(t, server.url)
    const second = await connectClient(t, server.url)
    assert.equal((await first.listWorktrees()).worktrees.length, 1)
    const createdEvents = [
      once(first, 'worktreesUpdated'),
      once(second, 'worktreesUpdated'),
    ]
    const created = await first.createWorktree({
      project,
      baseBranch: 'main',
      branch: 'feature',
      path: '../feature',
    })
    for (const event of await Promise.all(createdEvents)) {
      assert.equal(event[0].change, 'created')
      assert.deepEqual(event[0].snapshot, created)
    }
    await assert.rejects(
      first.createWorktree({
        project,
        baseBranch: 'main',
        branch: 'feature',
        path: '../duplicate',
      }),
    )
    assert.equal(first.getStatus().state, 'connected')
    await first.ping()
    const removedEvents = [
      once(first, 'worktreesUpdated'),
      once(second, 'worktreesUpdated'),
    ]
    const removed = await second.deleteWorktree({
      project,
      path: join(root, 'feature'),
    })
    for (const event of await Promise.all(removedEvents)) {
      assert.equal(event[0].change, 'deleted')
      assert.deepEqual(event[0].snapshot, removed)
    }
    await git(
      project,
      'worktree',
      'add',
      '-b',
      'outside',
      join(root, 'outside'),
    )
    assert.equal((await second.listWorktrees()).worktrees.length, 1)
    const refreshedEvent = once(second, 'worktreesUpdated')
    assert.equal((await first.refreshWorktrees()).worktrees.length, 2)
    assert.equal((await refreshedEvent)[0].change, 'refreshed')
    first.stop()
    await second.createWorktree({
      project,
      baseBranch: 'main',
      branch: 'offline',
      path: '../offline',
    })
    const reconnected = await connectClient(t, server.url)
    assert.equal((await reconnected.listWorktrees()).worktrees.length, 3)
    // Invalid commands with IDs receive correlated errors without losing the socket.
    const raw = new WebSocket(server.url)
    t.after(() => raw.terminate())
    await once(raw, 'message')
    const reply = once(raw, 'message')
    raw.send(
      JSON.stringify({
        type: 'worktrees:create',
        id: 'invalid',
        input: { project },
      }),
    )
    const error = JSON.parse((await reply)[0].toString())
    assert.equal(error.type, 'error')
    assert.equal(error.id, 'invalid')
  },
)

test(
  'failed checkout hooks still reconcile cached worktrees and broadcast updates',
  { timeout: 30_000 },
  async (t) => {
    const { root, makeProject } = await fixture(t)
    const project = await makeProject('project')
    const otherProject = await makeProject('other project')
    await git(project, 'branch', 'existing')
    const hooks = join(root, 'hooks')
    await mkdir(hooks)
    await writeFile(
      join(hooks, 'post-checkout'),
      '#!/bin/sh\necho checkout-hook-failed >&2\nexit 1\n',
      { mode: 0o755 },
    )
    await git(project, 'config', 'core.hooksPath', hooks)
    const server = await startCompanionServer({
      port: 0,
      config: { projects: [project, otherProject] },
    })
    t.after(() => server.close())
    const creator = await connectClient(t, server.url)
    const observer = await connectClient(t, server.url)
    const updates: WorktreeUpdate[] = []
    const observed: WorktreeUpdate[] = []
    creator.on('worktreesUpdated', (update) => updates.push(update))
    observer.on('worktreesUpdated', (update) => observed.push(update))
    for (const branch of ['new-branch', '']) {
      const path = join(root, branch || 'existing-worktree')
      const before = await creator.listWorktrees()
      const input = {
        project,
        baseBranch: branch ? 'main' : 'existing',
        branch,
        path,
      }
      await assert.rejects(
        creator.createWorktree(input),
        /checkout-hook-failed/,
      )
      assert.equal(
        await git(path, 'symbolic-ref', '--short', 'HEAD'),
        branch || 'existing',
      )
      const snapshot = await creator.listWorktrees()
      assert.equal(snapshot.worktrees.length, before.worktrees.length + 1)
      assert.equal(snapshot.revision, before.revision + 1)
      assert.equal(
        snapshot.worktrees.find((entry) => entry.path === path)?.branch,
        branch || 'existing',
      )
      assert.ok(
        snapshot.worktrees.some((entry) => entry.project === otherProject),
      )
      assert.deepEqual(updates.at(-1)?.snapshot, snapshot)
      const reconnected = await connectClient(t, server.url)
      assert.deepEqual(await reconnected.listWorktrees(), snapshot)
      await assert.rejects(
        creator.createWorktree(input),
        /already exists|already (checked out|used)/,
      )
      assert.deepEqual(await creator.listWorktrees(), snapshot)
    }
    // The observer's subsequent reply follows all broadcasts on the same socket.
    assert.deepEqual(await observer.listWorktrees(), updates.at(-1)?.snapshot)
    assert.deepEqual(observed, updates)
    assert.equal(updates.length, 2)
    assert.equal(creator.getStatus().state, 'connected')
  },
)

test(
  'blank new branch checks out the base branch and broadcasts without creating a branch',
  { timeout: 30_000 },
  async (t) => {
    const { root, makeProject } = await fixture(t)
    const project = await makeProject('project')
    await git(project, 'branch', 'existing')
    await git(project, 'branch', 'another')
    const branches = await git(
      project,
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/',
    )
    const server = await startCompanionServer({
      port: 0,
      config: { projects: [project] },
    })
    t.after(() => server.close())
    const creator = await connectClient(t, server.url)
    const observer = await connectClient(t, server.url)
    for (const [baseBranch, branch] of [
      ['existing', ''],
      ['another', '   '],
    ]) {
      const path = join(root, `${baseBranch}-worktree`)
      const pushed = once(observer, 'worktreesUpdated')
      const snapshot = await creator.createWorktree({
        project,
        baseBranch,
        branch,
        path,
      })
      assert.equal(
        snapshot.worktrees.find((entry) => entry.path === path)?.branch,
        baseBranch,
      )
      assert.equal(
        await git(path, 'symbolic-ref', '--short', 'HEAD'),
        baseBranch,
      )
      const [update] = await pushed
      assert.equal(update.change, 'created')
      assert.deepEqual(update.snapshot, snapshot)
    }
    const before = await creator.listWorktrees()
    await assert.rejects(
      creator.createWorktree({
        project,
        baseBranch: 'main',
        branch: '',
        path: join(root, 'duplicate'),
      }),
      /already (checked out|used)/,
    )
    await assert.rejects(
      creator.createWorktree({
        project,
        baseBranch: 'missing',
        branch: '',
        path: join(root, 'missing'),
      }),
    )
    assert.deepEqual(await creator.listWorktrees(), before)
    assert.equal(
      await git(project, 'for-each-ref', '--format=%(refname)', 'refs/heads/'),
      branches,
    )
    assert.equal(creator.getStatus().state, 'connected')
  },
)

test('invalid startup config or project never opens a listener', async (t) => {
  const { root } = await fixture(t)
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  await assert.rejects(
    startCompanionServer({ port, config: { projects: [root] } }),
  )
  // Rebinding proves failed initialization left no accepting server behind.
  probe.listen(port, '127.0.0.1')
  await once(probe, 'listening')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
})

test('worktree protocol validates inputs and full snapshots', () => {
  const input = {
    project: 'repo',
    baseBranch: 'main',
    branch: '',
    path: '../worktree',
  }
  assert.ok(
    parseClientMessage(
      JSON.stringify({ type: 'worktrees:create', id: '1', input }),
    ),
  )
  for (const branch of [undefined, null, 42, '\0', 'a'.repeat(4097)]) {
    assert.equal(
      parseClientMessage(
        JSON.stringify({
          type: 'worktrees:create',
          id: '1',
          input: { ...input, branch },
        }),
      ),
      null,
    )
  }
  for (const input of [
    null,
    {},
    { project: 'repo', path: '\0' },
    { project: 'repo', path: 2 },
  ]) {
    assert.equal(
      parseClientMessage(
        JSON.stringify({ type: 'worktrees:delete', id: '1', input }),
      ),
      null,
    )
  }
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: 'worktrees',
        id: '1',
        snapshot: { revision: 1, projects: [], worktrees: [null] },
      }),
    ),
    null,
  )
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: 'worktrees:updated',
        change: 'unknown',
        snapshot: { revision: 1, projects: [], worktrees: [] },
      }),
    ),
    null,
  )
})
