import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { simpleGit } from 'simple-git'
import { stringify } from 'yaml'
import { startServer } from '../src/server/application'
import { ProcessVscodeServerManager } from '../src/server/vscode-manager'
import { listWorktrees, parseWorktrees } from '../src/server/git-utils'
import type { ClientMethods, ServerMethods, Worktree } from '../src/shared/api'
import { RPC_PATH } from '../src/shared/constants'
import { connectRpc } from '../src/shared/rpc-client'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-worktrees-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function repository(directory: string, name: string) {
  const path = join(directory, name)
  await mkdir(path)
  const git = simpleGit(path)
  await git.init(['--initial-branch=main'])
  await git.raw([
    '-c',
    'user.name=ADE Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'Initial commit',
  ])
  return { path, git }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected worktree update did not arrive')
    await delay(20)
  }
}

test('porcelain records preserve unusual paths and branch names and omit bare repositories', () => {
  const path = '/projects/name with spaces\nand "quotes"'
  assert.deepEqual(
    parseWorktrees(
      `worktree ${path}\0HEAD abc\0branch refs/heads/feature/nested\0locked reason\0\0worktree /projects/detached\0HEAD abc\0detached\0\0worktree /projects/bare\0bare\0\0`,
    ),
    [
      { path, basename: basename(path), branchName: 'feature/nested' },
      { path: '/projects/detached', basename: 'detached', branchName: null },
    ],
  )
})

test('discovers worktrees from all projects, deduplicates and isolates invalid projects', async (t) => {
  const directory = await fixture(t)
  const first = await repository(directory, 'first project')
  const second = await repository(directory, 'second')
  await first.git.raw([
    'worktree',
    'add',
    '-b',
    'feature/topic',
    join(directory, 'linked tree'),
  ])
  await first.git.raw([
    'worktree',
    'add',
    '--detach',
    join(directory, 'detached'),
  ])
  const worktrees = await listWorktrees([
    { mainWorktreePath: first.path },
    { mainWorktreePath: second.path },
    { mainWorktreePath: first.path },
    { mainWorktreePath: join(directory, 'missing') },
  ])
  assert.deepEqual(
    worktrees.map(({ basename, branchName }) => ({ basename, branchName })),
    [
      { basename: 'first project', branchName: 'main' },
      { basename: 'detached', branchName: null },
      { basename: 'linked tree', branchName: 'feature/topic' },
      { basename: 'second', branchName: 'main' },
    ],
  )
})

test(
  'startup, manual refresh, config reload and new connections deliver current worktrees',
  { timeout: 20_000 },
  async (t) => {
    const directory = await fixture(t)
    const first = await repository(directory, 'first')
    const second = await repository(directory, 'second')
    const path = join(directory, 'server.yaml')
    const config = (paths: string[]) =>
      stringify({
        host: '127.0.0.1',
        port: 0,
        projects: paths.map((mainWorktreePath) => ({ mainWorktreePath })),
        vscode: { settingsFile: join(directory, 'settings.json') },
      })
    await writeFile(path, config([first.path, second.path]))
    const server = await startServer(
      path,
      new ProcessVscodeServerManager(
        {
          dataDirectory: directory,
          prepare: async () => ({ node: '', entrypoint: '' }),
        },
        {
          launch: async () => {
            throw new Error('Unexpected launch')
          },
        },
      ),
      [],
    )
    t.after(() => server.close())
    const connect = () => {
      const updates: Worktree[][] = []
      const client = connectRpc<ServerMethods, ClientMethods>(
        `ws://127.0.0.1:${server.port}${RPC_PATH}`,
        {
          getClientInfo: () => ({ name: 'test', version: '1' }),
          settingsChanged: () => {},
          vscodeServersChanged: () => {},
          worktreesChanged: (worktrees) => {
            updates.push(worktrees)
          },
        },
      )
      t.after(() => client.close())
      return { client, updates, latest: () => updates.at(-1) }
    }
    const a = connect()
    const b = connect()
    await waitFor(() => a.latest()?.length === 2 && b.latest()?.length === 2)
    assert.deepEqual(
      a.latest()?.map((w) => w.basename),
      ['first', 'second'],
    )

    await first.git.raw([
      'worktree',
      'add',
      '-b',
      'feature/new',
      join(directory, 'new tree'),
    ])
    await a.client.rpc.refreshWorktrees()
    await waitFor(() => a.latest()?.length === 3 && b.latest()?.length === 3)
    assert.equal(
      b.latest()?.find((w) => w.basename === 'new tree')?.branchName,
      'feature/new',
    )

    await writeFile(path, 'projects: [\n')
    await delay(350)
    await a.client.rpc.refreshWorktrees()
    assert.equal(a.latest()?.length, 3)

    const replacement = join(directory, 'replacement.yaml')
    await writeFile(replacement, config([second.path]))
    await rename(replacement, path)
    await waitFor(() => a.latest()?.length === 1 && b.latest()?.length === 1)
    assert.equal(a.latest()?.[0].basename, 'second')

    const late = connect()
    await waitFor(() => late.latest()?.length === 1)
    assert.deepEqual(late.latest(), a.latest())

    await writeFile(path, config([]))
    await waitFor(
      () =>
        a.latest()?.length === 0 &&
        b.latest()?.length === 0 &&
        late.latest()?.length === 0,
    )

    await writeFile(path, config([first.path]))
    await waitFor(() => a.latest()?.length === 2 && b.latest()?.length === 2)
    await first.git.raw(['worktree', 'remove', join(directory, 'new tree')])
    await b.client.rpc.refreshWorktrees()
    await waitFor(() => a.latest()?.length === 1 && b.latest()?.length === 1)
    assert.equal(a.latest()?.[0].basename, 'first')
    await server.close()
    assert.equal(server.close(), server.close())
  },
)
