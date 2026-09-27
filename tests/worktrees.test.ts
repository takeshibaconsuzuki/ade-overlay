import {
  completeCreate,
  completeDelete,
} from './helpers/worktree-operations.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import os, { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { stringify } from 'yaml'
import which from 'which'
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

function nextChange(
  client: CompanionClient,
  change: WorktreeUpdate['change'],
): Promise<[WorktreeUpdate]> {
  return new Promise((resolve) => {
    const listener = (update: WorktreeUpdate) => {
      if (update.change !== change) return
      client.off('worktreesUpdated', listener)
      resolve([update])
    }
    client.on('worktreesUpdated', listener)
  })
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
  const store = await WorktreeStore.open([
    { mainWorktreePath: first },
    { mainWorktreePath: second },
    { mainWorktreePath: first },
  ])
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
  await assert.rejects(
    WorktreeStore.open([{ mainWorktreePath: linked }]),
    /main worktree root/,
  )
  await assert.rejects(WorktreeStore.open([{ mainWorktreePath: root }]))
})

test('async mutations preserve cache on failure, serialize conflicts and protect dirty/main/locked trees', async (t) => {
  const { root, makeProject } = await fixture(t)
  const project = await makeProject('project')
  const store = await WorktreeStore.open([{ mainWorktreePath: project }])
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
  assert.deepEqual(
    changes.filter((change) => change === 'created' || change === 'deleted'),
    ['created', 'deleted'],
  )
  assert.ok(changes.includes('operation'))
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
    const createdEvents = [
      nextChange(first, 'created'),
      nextChange(second, 'created'),
    ]
    const created = await completeCreate(first, {
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
      completeCreate(first, {
        project,
        baseBranch: 'main',
        branch: 'feature',
        path: '../duplicate',
      }),
    )
    assert.equal(first.getStatus().state, 'connected')
    await first.setWorktreeError({ project, path: join(root, 'duplicate') })
    await first.ping()
    const removedEvents = [
      nextChange(first, 'deleted'),
      nextChange(second, 'deleted'),
    ]
    const removed = await completeDelete(second, {
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
    await completeCreate(second, {
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
      assert.deepEqual(updates.at(-1)?.snapshot, snapshot)
      const reconnected = await connectClient(t, server.url)
      assert.deepEqual(await reconnected.listWorktrees(), snapshot)
      await assert.rejects(
        completeCreate(creator, input),
        /already exists|already (checked out|used)/,
      )
      assert.deepEqual(await creator.listWorktrees(), snapshot)
    }
    // The observer's subsequent reply follows all broadcasts on the same socket.
    assert.deepEqual(await observer.listWorktrees(), updates.at(-1)?.snapshot)
    assert.deepEqual(observed, updates)
    assert.equal(
      updates.filter((update) =>
        update.snapshot.worktrees.some((row) => row.operation),
      ).length,
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
      const pushed = nextChange(observer, 'created')
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
      const [update] = await pushed
      assert.equal(update.change, 'created')
      assert.deepEqual(update.snapshot, snapshot)
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
  const store = await WorktreeStore.open([
    {
      mainWorktreePath: project,
      bootstrapCommand: `printf 'bootstrap_value=account-shell' > setup.sh && source ./setup.sh && printf '%s' "$bootstrap_value" > bootstrap-result.txt`,
    },
  ])
  const path = join(root, 'shell-worktree')
  const snapshot = await store.create({
    project,
    path,
    branch: 'shell-worktree',
    baseBranch: 'main',
  })
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
  const physical = join(root, 'physical')
  const alias = join(root, 'alias')
  await mkdir(physical)
  await symlink(
    physical,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const store = await WorktreeStore.open([
    {
      mainWorktreePath: project,
      bootstrapCommand: 'echo alias-bootstrap-failed >&2 && exit 1',
    },
  ])
  const updates: WorktreeUpdate[] = []
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
    await assert.rejects(store.create(input), /already exists/)
    const cleared = store.setError({ project, path })
    assert.equal(cleared.worktrees.length, failed.worktrees.length)
    assert.equal(
      cleared.worktrees.find((row) => row.path === path)?.error,
      undefined,
    )
  }
  for (const { snapshot } of updates) {
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
      await restarted.ping()
      const finished = nextChange(restarted, 'deleted')
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
