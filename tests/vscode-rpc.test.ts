import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { simpleGit } from 'simple-git'
import { stringify } from 'yaml'
import { startServer } from '../src/server/application'
import { ProcessVscodeServerManager } from '../src/server/vscode-manager'
import type {
  ClientMethods,
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
    await simpleGit(repo).init()
    const config = join(directory, 'server.yaml')
    await writeFile(
      config,
      stringify({
        host: '127.0.0.1',
        port: 0,
        projects: [{ mainWorktreePath: repo }],
      }),
    )
    let ready!: () => void
    let exit!: (result: { code: number; signal: null }) => void
    let launches = 0
    const vscode = new ProcessVscodeServerManager(
      {
        dataDirectory: directory,
        prepare: async () => ({ node: '', entrypoint: '' }),
      },
      {
        launch: async () => {
          launches++
          return {
            ready: new Promise<{ port: number; token: string }>((resolve) => {
              ready = () => resolve({ port: 1234, token: 'test-token' })
            }),
            exited: new Promise<{ code: number; signal: null }>((resolve) => {
              exit = resolve
            }),
            stop: async () => {
              ready()
              exit({ code: 0, signal: null })
            },
          }
        },
      },
    )
    const server = await startServer(config, vscode)
    t.after(() => server.close())
    const connect = () => {
      let latest: VscodeServerStatus[] = []
      let worktrees: Worktree[] = []
      const client = connectRpc<ServerMethods, ClientMethods>(
        `ws://127.0.0.1:${server.port}${RPC_PATH}`,
        {
          getClientInfo: () => ({ name: 'test', version: '1' }),
          worktreesChanged: (next) => {
            worktrees = next
          },
          vscodeServersChanged: (next) => {
            latest = next
          },
        },
      )
      t.after(() => client.close())
      return { client, status: () => latest[0], path: () => worktrees[0]?.path }
    }
    const a = connect()
    const b = connect()
    await waitFor(() => !!a.path() && !!b.path())
    assert.equal(a.status(), undefined)
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
    exit({ code: 17, signal: null })
    await waitFor(() => !!b.status()?.error && !!reconnected.status()?.error)
    await reconnected.client.rpc.clearVscodeServerError(
      reconnected.path(),
      reconnected.status().error!.id,
    )
    await waitFor(() => !b.status()?.error && !reconnected.status()?.error)
    assert.equal(b.status().state, 'stopped')
    assert.equal(launches, 1)
  },
)

test('runtime preparation failure rejects startup and closes the manager', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-vscode-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = join(directory, 'server.yaml')
  await writeFile(config, stringify({ host: '127.0.0.1', port: 0 }))
  let attempts = 0
  const vscode = new ProcessVscodeServerManager(
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
  await assert.rejects(startServer(config, vscode), /Download unavailable/)
  assert.equal(attempts, 1)
  assert.throws(() => vscode.ensure(directory), /closed/)
})
