import childProcess, {
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connectRpc } from '../../src/shared/rpc-client'
import type { DesktopClientMethods, ServerMethods } from '../../src/shared/api'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { simpleGit } from 'simple-git'
import { startIntegrationServer, runDesktopClient } from './harness'

test('local and remote stops preserve the editor session before worktree deletion', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-lifecycle-integration-'))
  console.log('Lifecycle test data:', directory)
  const repo = join(directory, 'main')
  const linked = join(directory, 'linked')
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
  await git.raw(['worktree', 'add', '-b', 'linked', linked])
  const server = await startIntegrationServer(directory, [repo])
  const spawn = childProcess.spawn
  let vscodeChild: ChildProcess | undefined
  let vscodePid: number | undefined
  t.mock.method(
    childProcess,
    'spawn',
    (command: string, args: string[], options: SpawnOptions) => {
      const child = spawn(command, args, options)
      if (args.includes('--server-data-dir')) {
        vscodeChild = child
        vscodePid = child.pid
      }
      return child
    },
  )
  syncBuiltinESMExports()
  const restorePid = () => {
    if (vscodeChild)
      Object.defineProperty(vscodeChild, 'pid', {
        value: vscodePid,
        configurable: true,
      })
  }
  const remote = connectRpc<ServerMethods, DesktopClientMethods>(
    `ws://127.0.0.1:${server.port}/rpc`,
    {
      getClientInfo: () => ({
        kind: 'desktop',
        name: 'remote lifecycle client',
        version: '1',
      }),
      openChatTerminal: async () => {},
      focusChatTerminal: async () => false,
      openWorktree: async () => {},
      settingsChanged: () => {},
      worktreesChanged: () => {},
    },
  )
  // Let the desktop fixture request a stop through an independent RPC client.
  const control = createServer((request, response) => {
    if (request.url === '/fail-stop') {
      if (!vscodeChild) {
        response.statusCode = 500
        response.end()
        return
      }
      // Fail at the real termination boundary while keeping the process alive.
      Object.defineProperty(vscodeChild, 'pid', {
        value: 'invalid-pid',
        configurable: true,
      })
      response.end()
      return
    }
    if (request.url === '/allow-stop') {
      restorePid()
      response.end()
      return
    }
    void remote.rpc.stopVscodeServer(linked).then(
      () => {
        response.end()
      },
      (error: unknown) => {
        response.statusCode = 500
        response.end(String(error))
      },
    )
  })
  control.listen(0, '127.0.0.1')
  await once(control, 'listening')
  const address = control.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing control address')
  try {
    await runDesktopClient('lifecycle', {
      ADE_SERVER_URL: `ws://127.0.0.1:${server.port}/rpc`,
      ADE_LIFECYCLE_CONTROL: `http://127.0.0.1:${address.port}`,
      ADE_LIFECYCLE_DATA: directory,
      ADE_LIFECYCLE_WORKTREE: linked,
    })
  } finally {
    restorePid()
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await new Promise<void>((resolve, reject) =>
      control.close((error) => (error ? reject(error) : resolve())),
    )
    await remote.close()
    await server.close()
  }
})
