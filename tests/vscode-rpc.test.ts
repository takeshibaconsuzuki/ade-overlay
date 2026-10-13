import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { simpleGit } from 'simple-git'
import { stringify } from 'yaml'
import { startServer } from '../src/server/application'
import { ProcessVscodeServerFactory } from '../src/server/vscode-server'
import type {
  DesktopClientMethods,
  ServerMethods,
  VscodeServerStatus,
  Worktree,
} from '../src/shared/api'
import { connectRpc } from '../src/shared/rpc-client'
import { RPC_PATH } from '../src/shared/constants'

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected RPC update did not arrive')
    await delay(10)
  }
}

test(
  'RPC broadcasts lifecycle and dismissal, and reconnect receives current status',
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'ade-vscode-rpc-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const repo = join(directory, 'repo')
    await mkdir(repo)
    const git = simpleGit(repo)
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
    const linked = join(directory, 'linked')
    await git.raw(['worktree', 'add', '-b', 'linked', linked])
    const config = join(directory, 'server.yaml')
    await writeFile(
      config,
      stringify({
        host: '127.0.0.1',
        port: 0,
        projects: [{ mainWorktreePath: repo }],
        vscode: { settingsFile: join(directory, 'settings.json') },
      }),
    )
    let ready!: () => void
    let exit!: (result: { code: number; signal: null }) => void
    const serverUrls: string[] = []
    let launches = 0
    let stops = 0
    let stopGate = Promise.resolve()
    let releaseStop = () => {}
    t.after(() => releaseStop())
    const vscode = new ProcessVscodeServerFactory(
      {
        dataDirectory: directory,
        prepare: async () => ({ node: '', entrypoint: '' }),
      },
      {
        launch: async (
          _installation,
          _path,
          _directory,
          _signal,
          _extensions,
          serverUrl,
        ) => {
          serverUrls.push(serverUrl)
          launches++
          return {
            ready: new Promise<{ port: number; token: string }>((resolve) => {
              ready = () => resolve({ port: 1234, token: 'test-token' })
            }),
            exited: new Promise<{ code: number; signal: null }>((resolve) => {
              exit = resolve
            }),
            stop: async () => {
              stops++
              await stopGate
              ready()
              exit({ code: 0, signal: null })
            },
          }
        },
      },
    )
    const server = await startServer(config, vscode, [])
    t.after(() => server.close())
    const connect = () => {
      let latest: VscodeServerStatus[] = []
      let worktrees: Worktree[] = []
      const client = connectRpc<ServerMethods, DesktopClientMethods>(
        `ws://127.0.0.1:${server.port}${RPC_PATH}`,
        {
          getClientInfo: () => ({
            kind: 'desktop',
            name: 'test',
            version: '1',
          }),
          openChatTerminal: async () => {},
          focusChatTerminal: async () => false,
          openWorktree: async () => {},
          chatTurnFinished: () => {},
          settingsChanged: () => {},
          worktreesChanged: (next) => {
            worktrees = next
            latest = next.map((worktree) => worktree.vscode)
          },
        },
      )
      t.after(() => client.close())
      return {
        client,
        status: () => latest[0],
        error: () => worktrees[0]?.error,
        path: () => worktrees[0]?.path,
        linked: () => worktrees.find((worktree) => worktree.path === linked),
      }
    }
    const a = connect()
    const b = connect()
    await waitFor(() => !!a.path() && !!b.path())
    assert.equal(a.status().state, 'stopped')
    await assert.rejects(
      a.client.rpc.ensureVscodeServer(join(directory, 'unknown')),
      /Unknown worktree/,
    )
    await Promise.all([
      a.client.rpc.ensureVscodeServer(a.path()),
      b.client.rpc.ensureVscodeServer(b.path()),
    ])
    await waitFor(
      () =>
        a.status()?.state === 'starting' && b.status()?.state === 'starting',
    )
    assert.equal(launches, 1)
    assert.deepEqual(serverUrls, [`ws://127.0.0.1:${server.port}${RPC_PATH}`])
    ready()
    await waitFor(
      () => a.status()?.state === 'running' && b.status()?.state === 'running',
    )
    await a.client.close()
    const reconnected = connect()
    await waitFor(() => reconnected.status()?.state === 'running')
    assert.equal(launches, 1)
    await b.client.rpc.refreshWorktrees()
    assert.equal(b.status().state, 'running')
    assert.equal(launches, 1)
    stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    await b.client.rpc.stopVscodeServer(b.path())
    await waitFor(
      () =>
        b.status()?.state === 'stopping' &&
        reconnected.status()?.state === 'stopping',
    )
    // The RPC returned while termination is still blocked.
    await assert.rejects(b.client.rpc.ensureVscodeServer(b.path()), /stopping/)
    releaseStop()
    await waitFor(
      () =>
        b.status()?.state === 'stopped' &&
        reconnected.status()?.state === 'stopped',
    )
    assert.ok(stops > 0)
    await b.client.rpc.ensureVscodeServer(b.path())
    await waitFor(() => b.status()?.state === 'starting')
    ready()
    await waitFor(() => b.status()?.state === 'running')
    exit({ code: 17, signal: null })
    await waitFor(() => !!b.error() && !!reconnected.error())
    await reconnected.client.rpc.clearWorktreeError(
      reconnected.path(),
      reconnected.error()!.id,
    )
    await waitFor(() => !b.error() && !reconnected.error())
    assert.equal(b.status().state, 'stopped')
    assert.equal(launches, 2)
    await writeFile(join(linked, 'dirty.txt'), 'keep me')
    await b.client.rpc.ensureVscodeServer(linked)
    ready()
    await waitFor(() => b.linked()?.vscode.state === 'running')
    stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    await b.client.rpc.deleteWorktree(linked)
    await waitFor(
      () => !!b.linked()?.deleting && !!reconnected.linked()?.deleting,
    )
    await b.client.rpc.deleteWorktree(linked)
    await assert.rejects(
      b.client.rpc.ensureVscodeServer(linked),
      /being deleted/,
    )
    // Discovery remains available while another client's accepted deletion is pending.
    await reconnected.client.rpc.refreshWorktrees()
    assert.equal(b.linked()?.deleting, true)
    releaseStop()
    await waitFor(() => !!b.linked()?.error && !!reconnected.linked()?.error)
    assert.equal(b.linked()?.deleting, false)
    assert.match(b.linked()!.error!.message, /untracked|modified/)
    await reconnected.client.rpc.clearWorktreeError(
      linked,
      reconnected.linked()!.error!.id,
    )
    await waitFor(() => !b.linked()?.error && !reconnected.linked()?.error)
    await rm(join(linked, 'dirty.txt'))
    await b.client.rpc.deleteWorktree(linked)
    await waitFor(() => !b.linked() && !reconnected.linked())
    await b.client.rpc.ensureVscodeServer(b.path())
    await waitFor(() => b.status()?.state === 'starting')
    const previousStops = stops
    await writeFile(
      config,
      stringify({
        host: '127.0.0.1',
        port: 0,
        projects: [],
        vscode: { settingsFile: join(directory, 'settings.json') },
      }),
    )
    await waitFor(() => !b.path() && !reconnected.path())
    assert.ok(
      stops > previousStops,
      'removing the project terminates its pending server launch',
    )
    ready()
    await b.client.rpc.refreshWorktrees()
    assert.equal(b.path(), undefined)
  },
)

test('runtime preparation failure rejects startup and closes the manager', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-vscode-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = join(directory, 'server.yaml')
  await writeFile(
    config,
    stringify({
      host: '127.0.0.1',
      port: 0,
      vscode: { settingsFile: join(directory, 'settings.json') },
    }),
  )
  let attempts = 0
  const vscode = new ProcessVscodeServerFactory(
    {
      dataDirectory: directory,
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
  await assert.rejects(startServer(config, vscode, []), /Download unavailable/)
  assert.equal(attempts, 1)
  assert.throws(() => vscode.create(directory, () => {}), /closed/)
})
