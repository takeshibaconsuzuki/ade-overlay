import {
  completeCreate,
  completeDelete,
} from '../helpers/worktree-operations.ts'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
import os, { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { socketPeer } from '../helpers/socket.ts'
import { stringify } from 'yaml'
import which from 'which'
import { CompanionClient } from '../../src/main/companion-client.ts'
import { loadServerConfig, parseServerArgs } from '../../src/server/config.ts'
import { startCompanionServer } from '../../src/server/server.ts'
import { WorktreeStore } from '../../src/server/worktrees/worktree-store.ts'
import { WorktreeEditors } from '../fixtures/worktree-editors.ts'
import {
  companionRequests,
  type WorktreeSnapshot,
} from '../../src/shared/companion.ts'

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

function nextSnapshot(
  client: CompanionClient,
  matches: (snapshot: WorktreeSnapshot) => boolean,
): Promise<WorktreeSnapshot> {
  return new Promise((resolve) => {
    const listener = (update: WorktreeSnapshot) => {
      if (!matches(update)) return
      client.off('worktreesUpdated', listener)
      resolve(update)
    }
    client.on('worktreesUpdated', listener)
  })
}

test(
  'shutdown drains creation admitted before asynchronous path resolution finishes',
  { timeout: 10_000 },
  async (t) => {
    const { root, makeProject } = await fixture(t)
    const project = await makeProject('project')
    const destination = join(root, 'created-during-close')
    const server = await startCompanionServer({
      config: { projects: [{ mainWorktreePath: project }] },
      port: 0,
    })
    t.after(() => server.close())
    const client = await connectClient(t, server.url)
    let entered!: () => void
    let release!: () => void
    const resolving = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = fs.realpath
    const mock = t.mock.method(
      fs,
      'realpath',
      async (path: string, ...args: unknown[]) => {
        if (path === destination) {
          entered()
          await held
        }
        return Reflect.apply(original, fs, [path, ...args])
      },
    )
    syncBuiltinESMExports()
    try {
      const creating = client
        .createWorktree({
          project,
          path: destination,
          branch: 'drained',
          baseBranch: 'main',
        })
        .catch((error) => error)
      await resolving
      let closed = false
      const closing = server.close().then(() => {
        closed = true
      })
      await delay(50)
      assert.equal(
        closed,
        false,
        'close includes work still resolving its destination',
      )
      release()
      await closing
      await creating
      assert.match(
        await git(project, 'worktree', 'list', '--porcelain'),
        /drained/,
      )
      await access(join(destination, '.git'))
    } finally {
      release()
      mock.mock.restore()
      syncBuiltinESMExports()
    }
  },
)

test('companion setup is an explicit command with no extension-only alias', () => {
  assert.deepEqual(parseServerArgs(['--setup', '--config', 'server.yaml']), {
    configPath: 'server.yaml',
    setup: true,
  })
  assert.throws(() => parseServerArgs(['--install-extension']))
})

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
    stringify({
      projects: [
        {
          mainWorktreePath: './relative repo',
          bootstrapCommand: 'npm install',
        },
        { mainWorktreePath: '~/project' },
      ],
    }),
  )
  assert.deepEqual(await loadServerConfig(path), {
    projects: [
      {
        mainWorktreePath: join(root, 'relative repo'),
        bootstrapCommand: 'npm install',
      },
      { mainWorktreePath: join(homedir(), 'project') },
    ],
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
  const store = await WorktreeStore.open(
    [
      { mainWorktreePath: first },
      { mainWorktreePath: second },
      { mainWorktreePath: first },
    ],
    new WorktreeEditors(),
  )
  const snapshot = store.list()
  assert.ok(snapshot.worktrees.every((row) => !('head' in row)))
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
  await assert.rejects(
    WorktreeStore.open([{ mainWorktreePath: linked }], new WorktreeEditors()),
    /main worktree root/,
  )
  await assert.rejects(
    WorktreeStore.open([{ mainWorktreePath: root }], new WorktreeEditors()),
  )
})

test('async mutations preserve cache on failure, serialize conflicts and protect dirty/main/locked trees', async (t) => {
  const { root, makeProject } = await fixture(t)
  const project = await makeProject('project')
  const store = await WorktreeStore.open(
    [{ mainWorktreePath: project }],
    new WorktreeEditors(),
  )
  const input = {
    project,
    baseBranch: 'main',
    branch: 'feature/test',
    path: '../new worktree',
  }
  const updates: WorktreeSnapshot[] = []
  store.on('update', (snapshot) => updates.push(snapshot))
  const results = await Promise.allSettled([
    store.startCreate(input),
    store.startCreate(input),
  ])
  // Path resolution is asynchronous, so either request can be admitted first.
  const fulfilled = results.find((result) => result.status === 'fulfilled')
  const rejected = results.find((result) => result.status === 'rejected')
  assert.ok(fulfilled)
  assert.ok(rejected)
  assert.match(String(rejected.reason), /already running|already exists/)
  const accepted = fulfilled.value
  const path = join(root, 'new worktree')
  assert.equal(
    accepted.worktrees.find((row) => row.path === path)?.operation,
    'creating',
  )
  await store.settled()
  const created = store.list()
  const row = created.worktrees.find((entry) => entry.path === path)!
  assert.equal(row.branch, input.branch)
  assert.equal(row.operation, undefined)
  assert.equal(row.error, undefined)
  assert.deepEqual(updates.at(-1), created)
  await assert.rejects(
    store.startCreate({ ...input, project: root }),
    /not configured/,
  )
  for (const fields of [
    { branch: '-bad' },
    { branch: 'bad name' },
    { branch: 'bad-base', baseBranch: '--help' },
  ]) {
    const path = join(root, 'invalid')
    const accepted = await store.startCreate({ ...input, ...fields, path })
    assert.equal(
      accepted.worktrees.find((row) => row.path === path)?.operation,
      'creating',
    )
    await store.settled()
    const failed = store.list().worktrees.find((row) => row.path === path)!
    assert.ok(failed.error)
    assert.equal(failed.operation, undefined)
    assert.equal(failed.missing, true)
    store.setError({ project, path })
  }
  await assert.rejects(
    store.startDelete({ project, path: project }),
    /main worktree/,
  )
  await assert.rejects(
    store.startDelete({ project, path: root }),
    /not in the cache/,
  )
  await writeFile(join(path, 'untracked.txt'), 'Keep me')
  const deleting = await store.startDelete({ project, path })
  assert.equal(
    deleting.worktrees.find((row) => row.path === path)?.operation,
    'deleting',
  )
  await store.settled()
  assert.match(
    store.list().worktrees.find((row) => row.path === path)?.error ?? '',
    /untracked|modified/i,
  )
  assert.equal(await readFile(join(path, 'untracked.txt'), 'utf8'), 'Keep me')
  await rm(join(path, 'untracked.txt'))
  await git(project, 'worktree', 'lock', path)
  // Even a lock made after the last scan must be honored by Git.
  await store.startDelete({ project, path })
  await store.settled()
  assert.match(
    store.list().worktrees.find((row) => row.path === path)?.error ?? '',
    /locked/i,
  )
  await store.refresh()
  await assert.rejects(store.startDelete({ project, path }), /Unlock/)
  await git(project, 'worktree', 'unlock', path)
  await store.refresh()
  await store.startDelete({ project, path })
  await store.settled()
  assert.equal(store.list().worktrees.length, 1)
  assert.deepEqual(updates.at(-1), store.list())
  assert.ok(
    await git(project, 'rev-parse', '--verify', 'refs/heads/feature/test'),
  )
})

test('synthetic creation failures stay outside Git membership and disappear when cleared', async (t) => {
  const { root, makeProject } = await fixture(t)
  const project = await makeProject('project')
  const other = await makeProject('other')
  const editors = new WorktreeEditors()
  const store = await WorktreeStore.open(
    [{ mainWorktreePath: project }, { mainWorktreePath: other }],
    editors,
  )
  const membership = structuredClone(editors.retained[0])
  assert.equal(membership.length, 2)
  for (const record of membership) {
    assert.deepEqual(Object.keys(record).sort(), [
      'branch',
      'locked',
      'main',
      'path',
      'project',
      'prunable',
    ])
  }
  await store.openEditor({ project: other, path: other })
  assert.equal(editors.retained.length, 1)

  const path = join(root, 'never-created')
  const accepted = await store.startCreate({
    project,
    path,
    branch: 'invalid branch',
    baseBranch: 'main',
  })
  assert.deepEqual(
    accepted.worktrees.find((row) => row.path === path),
    {
      project,
      path,
      branch: 'invalid branch',
      main: false,
      locked: false,
      prunable: false,
      missing: true,
      operation: 'creating',
      error: undefined,
      editor: 'stopped',
      editorDetail: undefined,
    },
  )
  assert.deepEqual(
    store.setError({ project, path, error: 'Late page error' }),
    accepted,
  )
  await store.settled()
  const failure = store.list().worktrees.find((row) => row.path === path)!
  assert.ok(failure.error)
  assert.equal(failure.missing, true)
  assert.equal(failure.operation, undefined)
  assert.equal(editors.retained.length, 2)
  assert.deepEqual(editors.retained[1], membership)
  await assert.rejects(store.openEditor({ project, path }), /unavailable/)
  assert.deepEqual(
    (await store.refresh()).worktrees.find((row) => row.path === path),
    failure,
  )
  assert.deepEqual(editors.retained[2], membership)
  const cleared = store.setError({ project, path })
  assert.ok(!cleared.worktrees.some((row) => row.path === path))
  assert.equal(
    cleared.worktrees.find((row) => row.path === other)?.editor,
    'running',
  )
  assert.equal(editors.retained.length, 3)
})

test('Git discovery replaces creation intent without losing its error or reconciling on editor status', async (t) => {
  const { root, makeProject } = await fixture(t)
  const project = await makeProject('project')
  const editors = new WorktreeEditors()
  const store = await WorktreeStore.open(
    [{ mainWorktreePath: project }],
    editors,
  )
  const path = join(root, 'recovered')
  await store.startCreate({
    project,
    path,
    branch: 'bad branch',
    baseBranch: 'main',
  })
  await store.settled()
  const error = store.list().worktrees.find((row) => row.path === path)!.error
  assert.ok(error)
  await git(project, 'worktree', 'add', '-b', 'recovered', path)
  const recovered = (await store.refresh()).worktrees.find(
    (row) => row.path === path,
  )!
  assert.equal(recovered.branch, 'recovered')
  assert.equal(recovered.missing, undefined)
  assert.equal(recovered.error, error)
  const reconciliations = editors.retained.length
  await store.openEditor({ project, path })
  assert.equal(editors.retained.length, reconciliations)
  assert.equal(
    store.list().worktrees.find((row) => row.path === path)?.error,
    error,
  )
  const cleared = store
    .setError({ project, path })
    .worktrees.find((row) => row.path === path)!
  assert.ok(cleared)
  assert.equal(cleared.error, undefined)
  assert.equal(cleared.editor, 'running')
  assert.equal(editors.retained.length, reconciliations)

  await git(project, 'worktree', 'remove', path)
  const removed = await store.refresh()
  assert.ok(!removed.worktrees.some((row) => row.path === path))
  assert.equal(editors.status({ project, path }), 'stopped')
  assert.equal(editors.retained.length, reconciliations + 1)
})

test(
  'first connection sees populated cache; create/delete/refresh broadcast to every client',
  { timeout: 30_000 },
  async (t) => {
    const { root, makeProject } = await fixture(t)
    const project = await makeProject('project')
    const configPath = join(root, 'server.yaml')
    await writeFile(
      configPath,
      stringify({ projects: [{ mainWorktreePath: project }] }),
    )
    const server = await startCompanionServer({ port: 0, configPath })
    t.after(() => server.close())
    const first = await connectClient(t, server.url)
    const second = await connectClient(t, server.url)
    assert.equal((await first.listWorktrees()).worktrees.length, 1)
    const createdFeature = (snapshot: WorktreeSnapshot) =>
      snapshot.worktrees.some(
        (row) => row.branch === 'feature' && !row.operation && !row.error,
      )
    const createdEvents = [
      nextSnapshot(first, createdFeature),
      nextSnapshot(second, createdFeature),
    ]
    const created = await completeCreate(first, {
      project,
      baseBranch: 'main',
      branch: 'feature',
      path: '../feature',
    })
    for (const event of await Promise.all(createdEvents)) {
      assert.deepEqual(event, created)
    }
    await assert.rejects(
      completeCreate(first, {
        project,
        baseBranch: 'main',
        branch: 'feature',
        path: '../duplicate',
      }),
    )
    assert.equal(first.getStatus().state, 'connected')
    await first.setWorktreeError({ project, path: join(root, 'duplicate') })
    await first.listWorktrees()
    const removedFeature = (snapshot: WorktreeSnapshot) =>
      !snapshot.worktrees.some((row) => row.path === join(root, 'feature'))
    const removedEvents = [
      nextSnapshot(first, removedFeature),
      nextSnapshot(second, removedFeature),
    ]
    const removed = await completeDelete(second, {
      project,
      path: join(root, 'feature'),
    })
    for (const event of await Promise.all(removedEvents)) {
      assert.deepEqual(event, removed)
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
    const refreshed = await first.refreshWorktrees()
    assert.equal(refreshed.worktrees.length, 2)
    assert.deepEqual((await refreshedEvent)[0], refreshed)
    first.stop()
    await completeCreate(second, {
      project,
      baseBranch: 'main',
      branch: 'offline',
      path: '../offline',
    })
    const reconnected = await connectClient(t, server.url)
    assert.equal((await reconnected.listWorktrees()).worktrees.length, 3)
    const { socket } = await socketPeer(t, server.url)
    const reply = await socket
      .timeout(2000)
      .emitWithAck('worktrees:create', { project })
    assert.equal(reply.ok, false)
    assert.ok(reply.error)
    assert.equal(socket.connected, true)
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
      config: {
        projects: [
          { mainWorktreePath: project },
          { mainWorktreePath: otherProject },
        ],
      },
    })
    t.after(() => server.close())
    const creator = await connectClient(t, server.url)
    const observer = await connectClient(t, server.url)
    const updates: WorktreeSnapshot[] = []
    const observed: WorktreeSnapshot[] = []
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
        completeCreate(creator, input),
        /checkout-hook-failed/,
      )
      assert.equal(
        await git(path, 'symbolic-ref', '--short', 'HEAD'),
        branch || 'existing',
      )
      const snapshot = await creator.listWorktrees()
      assert.equal(snapshot.worktrees.length, before.worktrees.length + 1)
      assert.ok(snapshot.revision > before.revision)
      assert.match(
        snapshot.worktrees.find((entry) => entry.path === path)?.error ?? '',
        /checkout-hook-failed/,
      )
      assert.equal(
        snapshot.worktrees.find((entry) => entry.path === path)?.branch,
        branch || 'existing',
      )
      assert.ok(
        snapshot.worktrees.some((entry) => entry.project === otherProject),
      )
      assert.deepEqual(updates.at(-1), snapshot)
      const reconnected = await connectClient(t, server.url)
      assert.deepEqual(await reconnected.listWorktrees(), snapshot)
      await assert.rejects(
        completeCreate(creator, input),
        /already exists|already (checked out|used)/,
      )
      assert.deepEqual(await creator.listWorktrees(), snapshot)
    }
    // The observer's subsequent reply follows all broadcasts on the same socket.
    assert.deepEqual(await observer.listWorktrees(), updates.at(-1))
    assert.deepEqual(observed, updates)
    assert.equal(
      updates.filter((update) => update.worktrees.some((row) => row.operation))
        .length,
      4,
    )
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
      config: { projects: [{ mainWorktreePath: project }] },
    })
    t.after(() => server.close())
    const creator = await connectClient(t, server.url)
    const observer = await connectClient(t, server.url)
    for (const [baseBranch, branch] of [
      ['existing', ''],
      ['another', '   '],
    ]) {
      const path = join(root, `${baseBranch}-worktree`)
      const pushed = nextSnapshot(observer, (snapshot) =>
        snapshot.worktrees.some(
          (row) => row.path === path && !row.operation && !row.error,
        ),
      )
      const snapshot = await completeCreate(creator, {
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
      assert.deepEqual(await pushed, snapshot)
    }
    const before = await creator.listWorktrees()
    await assert.rejects(
      completeCreate(creator, {
        project,
        baseBranch: 'main',
        branch: '',
        path: join(root, 'duplicate'),
      }),
      /already (checked out|used)/,
    )
    await assert.rejects(
      completeCreate(creator, {
        project,
        baseBranch: 'missing',
        branch: '',
        path: join(root, 'missing'),
      }),
    )
    const failed = await creator.listWorktrees()
    assert.equal(
      failed.worktrees.filter((row) => row.missing && row.error).length,
      2,
    )
    await creator.setWorktreeError({ project, path: join(root, 'duplicate') })
    const cleared = await creator.setWorktreeError({
      project,
      path: join(root, 'missing'),
    })
    assert.deepEqual(cleared.worktrees, before.worktrees)
    assert.equal(
      await git(project, 'for-each-ref', '--format=%(refname)', 'refs/heads/'),
      branches,
    )
    assert.equal(creator.getStatus().state, 'connected')
  },
)

test('bootstrap uses the account shell for shell-specific commands', async (t) => {
  const { root, makeProject } = await fixture(t)
  // Git for Windows supplies Bash even when the Windows account has no shell.
  const shell =
    process.platform === 'win32'
      ? resolve(dirname(await which('git')), '../bin/bash.exe')
      : await which('bash')
  const account = os.userInfo()
  t.mock.method(os, 'userInfo', () => ({ ...account, shell }))
  const project = await makeProject('project')
  const store = await WorktreeStore.open(
    [
      {
        mainWorktreePath: project,
        bootstrapCommand: `printf 'bootstrap_value=account-shell' > setup.sh && source ./setup.sh && printf '%s' "$bootstrap_value" > bootstrap-result.txt`,
      },
    ],
    new WorktreeEditors(),
  )
  const path = join(root, 'shell-worktree')
  const accepted = await store.startCreate({
    project,
    path,
    branch: 'shell-worktree',
    baseBranch: 'main',
  })
  assert.equal(
    accepted.worktrees.find((row) => row.path === path)?.operation,
    'creating',
  )
  await store.settled()
  const snapshot = store.list()
  assert.equal(
    await readFile(join(path, 'bootstrap-result.txt'), 'utf8'),
    'account-shell',
  )
  const row = snapshot.worktrees.find((row) => row.path === path)!
  assert.equal(row.operation, undefined)
  assert.equal(row.error, undefined)
})

test('creation failures through directory aliases stay on the canonical worktree', async (t) => {
  const { root, makeProject } = await fixture(t)
  const project = await makeProject('project')
  const projectAlias = join(root, 'project-alias')
  const physical = join(root, 'physical')
  const alias = join(root, 'alias')
  await mkdir(physical)
  await symlink(
    physical,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await symlink(
    project,
    projectAlias,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const store = await WorktreeStore.open(
    [
      {
        mainWorktreePath: projectAlias,
        bootstrapCommand: 'echo alias-bootstrap-failed >&2 && exit 1',
      },
    ],
    new WorktreeEditors(),
  )
  assert.deepEqual(store.list().projects, [project])
  const updates: WorktreeSnapshot[] = []
  store.on('update', (update) => updates.push(update))
  for (const name of ['nested/new', 'existing']) {
    const path = join(physical, name)
    if (name === 'existing') await mkdir(path)
    const input = {
      project,
      path: join(alias, name),
      branch: name,
      baseBranch: 'main',
    }
    const accepted = await store.startCreate(input)
    assert.equal(
      accepted.worktrees.find((row) => row.path === path)?.operation,
      'creating',
    )
    await store.settled()
    assert.equal(await realpath(input.path), path)
    const failed = store.list()
    const row = failed.worktrees.find((row) => row.path === path)!
    assert.ok(row)
    assert.match(row.error!, /alias-bootstrap-failed/)
    assert.equal(row.operation, undefined)
    assert.equal(row.missing, undefined)
    assert.equal(
      failed.worktrees.filter((row) => row.branch === name).length,
      1,
    )
    assert.equal(
      (await store.refresh()).worktrees.find((row) => row.path === path)?.error,
      row.error,
    )
    await assert.rejects(store.startCreate(input), /already exists/)
    const cleared = store.setError({ project, path })
    assert.equal(cleared.worktrees.length, failed.worktrees.length)
    assert.equal(
      cleared.worktrees.find((row) => row.path === path)?.error,
      undefined,
    )
  }
  for (const snapshot of updates) {
    for (const branch of ['nested/new', 'existing']) {
      assert.ok(
        snapshot.worktrees.filter((row) => row.branch === branch).length <= 1,
      )
    }
  }
})

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
    startCompanionServer({
      port,
      config: { projects: [{ mainWorktreePath: root }] },
    }),
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
  assert.ok(companionRequests.create.input.safeParse(input).success)
  for (const branch of [undefined, null, 42, '\0', 'a'.repeat(4097)])
    assert.equal(
      companionRequests.create.input.safeParse({ ...input, branch }).success,
      false,
    )
  for (const input of [
    null,
    {},
    { project: 'repo', path: '\0' },
    { project: 'repo', path: 2 },
  ])
    assert.equal(companionRequests.delete.input.safeParse(input).success, false)
  for (const snapshot of [
    { revision: 1, projects: [], worktrees: [null] },
    { revision: -1, projects: [], worktrees: [] },
  ])
    assert.equal(
      companionRequests.list.output.safeParse(snapshot).success,
      false,
    )
})

test(
  'accepted operations and bootstrap progress survive desktop reconnects, with persistent row failures',
  { timeout: 30_000 },
  async (t) => {
    const { root, makeProject } = await fixture(t)
    const project = await makeProject('project')
    const existing = join(root, 'existing')
    await git(project, 'worktree', 'add', '-b', 'existing', existing)
    const script = join(root, 'bootstrap.cjs')
    const gate = join(root, 'release')
    await writeFile(
      script,
      `
    const fs = require('node:fs');
    fs.writeFileSync('bootstrap-started.txt', process.cwd());
    const timer = setInterval(() => {
      if (!fs.existsSync(process.argv[2])) return;
      clearInterval(timer);
      const failure = fs.readFileSync(process.argv[2], 'utf8');
      if (failure) { console.error(failure); process.exit(1); }
    }, 20);
    setTimeout(() => process.exit(2), 10000).unref();
  `,
    )
    const server = await startCompanionServer({
      port: 0,
      config: {
        projects: [
          {
            mainWorktreePath: project,
            bootstrapCommand: `"${process.execPath}" "${script}" "${gate}"`,
          },
        ],
      },
    })
    t.after(() => server.close())
    try {
      const creator = await connectClient(t, server.url)
      const observer = await connectClient(t, server.url)
      const path = join(root, 'new')
      const created = await creator.createWorktree({
        project,
        path,
        branch: 'new',
        baseBranch: 'main',
      })
      assert.equal(
        created.worktrees.find((row) => row.path === path)?.operation,
        'creating',
      )
      const deleting = await creator.deleteWorktree({ project, path: existing })
      assert.equal(
        deleting.worktrees.find((row) => row.path === existing)?.operation,
        'deleting',
      )
      await assert.rejects(
        creator.createWorktree({
          project,
          path,
          branch: 'new',
          baseBranch: 'main',
        }),
        /already running/,
      )
      creator.stop()
      const restarted = await connectClient(t, server.url)
      const recovered = await restarted.listWorktrees()
      assert.equal(
        recovered.worktrees.find((row) => row.path === path)?.operation,
        'creating',
      )
      assert.equal(
        recovered.worktrees.find((row) => row.path === existing)?.operation,
        'deleting',
      )
      assert.deepEqual(await observer.listWorktrees(), recovered)
      await restarted.listWorktrees()
      const finished = nextSnapshot(
        restarted,
        (snapshot) => !snapshot.worktrees.some((row) => row.path === existing),
      )
      await writeFile(gate, '')
      await finished
      assert.equal(
        await readFile(join(path, 'bootstrap-started.txt'), 'utf8'),
        path,
      )
      assert.equal(
        (await restarted.listWorktrees()).worktrees.find(
          (row) => row.path === path,
        )?.operation,
        undefined,
      )
      assert.ok(
        !(await observer.listWorktrees()).worktrees.some(
          (row) => row.path === existing,
        ),
      )

      await writeFile(gate, 'bootstrap exploded')
      const failedPath = join(root, 'failed-bootstrap')
      await assert.rejects(
        completeCreate(restarted, {
          project,
          path: failedPath,
          branch: 'failed-bootstrap',
          baseBranch: 'main',
        }),
        /Bootstrap command failed:.*bootstrap exploded/s,
      )
      restarted.stop()
      const afterFailure = await connectClient(t, server.url)
      const row = (await afterFailure.listWorktrees()).worktrees.find(
        (row) => row.path === failedPath,
      )!
      assert.match(row.error!, /bootstrap exploded/)
      assert.equal(row.operation, undefined)
      assert.equal(row.missing, undefined)
      assert.equal(
        await git(failedPath, 'symbolic-ref', '--short', 'HEAD'),
        'failed-bootstrap',
      )
      await afterFailure.setWorktreeError({ project, path: failedPath })
      assert.equal(
        (await observer.listWorktrees()).worktrees.find(
          (row) => row.path === failedPath,
        )?.error,
        undefined,
      )

      // Bootstrap's untracked file makes safe deletion fail, on this row only.
      await assert.rejects(
        completeDelete(afterFailure, { project, path: failedPath }),
        /untracked|modified/i,
      )
      const dirty = (await afterFailure.listWorktrees()).worktrees.find(
        (row) => row.path === failedPath,
      )!
      assert.match(dirty.error!, /untracked|modified/i)
      assert.equal(dirty.operation, undefined)
      assert.equal(
        (await afterFailure.refreshWorktrees()).worktrees.find(
          (row) => row.path === failedPath,
        )?.error,
        dirty.error,
      )
      await afterFailure.setWorktreeError({ project, path: failedPath })
      assert.equal(
        (await observer.listWorktrees()).worktrees.find(
          (row) => row.path === failedPath,
        )?.error,
        undefined,
      )
    } finally {
      await writeFile(gate, '')
      await server.close()
    }
  },
)

test(
  'shutdown disconnects desktops while accepted bootstrap work finishes',
  { timeout: 15_000 },
  async (t) => {
    const { root, makeProject } = await fixture(t)
    const project = await makeProject('project')
    const path = join(root, 'during-shutdown')
    const gate = join(root, 'release-shutdown')
    const script = join(root, 'shutdown-bootstrap.cjs')
    await writeFile(
      script,
      `
      const fs = require('node:fs');
      const timer = setInterval(() => {
        if (!fs.existsSync(process.argv[2])) return;
        fs.writeFileSync('bootstrap-completed.txt', process.cwd());
        clearInterval(timer);
      }, 20);
      setTimeout(() => process.exit(2), 10000).unref();
      `,
    )
    const server = await startCompanionServer({
      port: 0,
      config: {
        projects: [
          {
            mainWorktreePath: project,
            bootstrapCommand: `"${process.execPath}" "${script}" "${gate}"`,
          },
        ],
      },
    })
    try {
      const client = await connectClient(t, server.url)
      const accepted = await client.createWorktree({
        project,
        path,
        branch: 'during-shutdown',
        baseBranch: 'main',
      })
      assert.equal(
        accepted.worktrees.find((row) => row.path === path)?.operation,
        'creating',
      )
      const disconnected = once(client, 'status', { signal: t.signal })
      let finished = false
      const closing = server.close().then(() => {
        finished = true
      })
      assert.equal((await disconnected)[0].state, 'reconnecting')
      client.stop()
      assert.equal(finished, false)
      await writeFile(gate, '')
      await closing
      assert.equal(
        await readFile(join(path, 'bootstrap-completed.txt'), 'utf8'),
        path,
      )
      assert.equal(
        await git(path, 'symbolic-ref', '--short', 'HEAD'),
        'during-shutdown',
      )
    } finally {
      await writeFile(gate, '')
      await server.close()
    }
  },
)

test(
  'development launcher shutdown lets accepted bootstrap work finish',
  { timeout: 30_000, skip: process.platform === 'win32' },
  async (t) => {
    const { root, makeProject } = await fixture(t)
    const project = await makeProject('project')
    const path = join(root, 'during-dev-shutdown')
    const started = join(root, 'bootstrap-started')
    const release = join(root, 'release-bootstrap')
    const completed = join(root, 'bootstrap-completed')
    // The development build owns its output directory. Keep it separate from
    // the browser assets used by other tests running at the same time.
    const checkout = join(root, 'checkout')
    await mkdir(join(checkout, 'scripts'), { recursive: true })
    await cp(new URL('../../src', import.meta.url), join(checkout, 'src'), {
      recursive: true,
    })
    for (const file of [
      'package.json',
      'scripts/server-dev.mjs',
      'scripts/settings-bridge-build.mjs',
    ])
      await copyFile(
        new URL(`../../${file}`, import.meta.url),
        join(checkout, file),
      )
    await symlink(
      fileURLToPath(new URL('../../node_modules', import.meta.url)),
      join(checkout, 'node_modules'),
      'dir',
    )
    const script = fileURLToPath(
      new URL('../fixtures/shutdown-bootstrap.mjs', import.meta.url),
    )
    const config = join(root, 'server.json')
    await writeFile(
      config,
      JSON.stringify({
        projects: [
          {
            mainWorktreePath: project,
            bootstrapCommand: [
              process.execPath,
              script,
              started,
              release,
              completed,
            ]
              .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
              .join(' '),
          },
        ],
        editor: { dataDir: join(root, 'editors') },
      }),
    )
    // Worktree operations need Git, but must not prepare a developer's runtime.
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'code'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const probe = createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const address = probe.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const child = spawn(
      process.execPath,
      ['scripts/server-dev.mjs', '--config', config],
      {
        cwd: checkout,
        env: {
          ...process.env,
          HOME: root,
          PATH: bin + delimiter + process.env.PATH,
          NODE_OPTIONS: undefined,
          ADE_COMPANION_HOST: '127.0.0.1',
          ADE_COMPANION_PORT: String(port),
          ADE_COMPANION_TOKEN: undefined,
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    for (const stream of [child.stdout!, child.stderr!])
      stream.on('data', (data) => {
        output = (output + data).slice(-16_000)
      })
    const exited = once(child, 'exit', { signal: t.signal })
    // Cleanup also observes spawn failures if readiness never arrives.
    void exited.catch(() => {})
    const client = new CompanionClient({
      url: `ws://127.0.0.1:${port}/companion`,
      reconnectDelayMs: 20,
    })
    try {
      client.connect()
      while (client.getStatus().state !== 'connected') {
        assert.equal(child.exitCode, null, output)
        await delay(20, undefined, { signal: t.signal })
      }
      const accepted = await client.createWorktree({
        project,
        path,
        branch: 'during-dev-shutdown',
        baseBranch: 'main',
      })
      assert.equal(
        accepted.worktrees.find((row) => row.path === path)?.operation,
        'creating',
      )
      while (
        !(await access(started).then(
          () => true,
          () => false,
        ))
      ) {
        assert.equal(child.exitCode, null, output)
        await delay(20, undefined, { signal: t.signal })
      }
      const disconnected = once(client, 'status', { signal: t.signal })
      assert.equal(child.kill('SIGTERM'), true)
      assert.equal((await disconnected)[0].state, 'reconnecting')
      client.stop()
      assert.equal(
        await Promise.race([
          exited.then(() => 'exited'),
          delay(200, 'waiting'),
        ]),
        'waiting',
        output,
      )
      await writeFile(release, '')
      assert.deepEqual(await exited, [0, null], output)
      assert.equal(await readFile(completed, 'utf8'), path)
    } finally {
      client.stop()
      await writeFile(release, '')
      // Only this test's detached process group; force cleanup on test failure.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        process.kill(-child.pid, 'SIGKILL')
        await closed
      }
    }
  },
)
