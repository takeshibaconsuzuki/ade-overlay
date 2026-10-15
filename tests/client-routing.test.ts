import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { stringify } from 'yaml'
import { simpleGit } from 'simple-git'
import { startServer } from '../src/server/application'
import { ProcessVscodeServerFactory } from '../src/server/vscode-server'
import type {
  Chat,
  ClientInfo,
  DesktopClientMethods,
  ExtensionClientMethods,
  ServerMethods,
} from '../src/shared/api'
import { MAX_RPC_PAYLOAD_BYTES, RPC_TIMEOUT_MS } from '../src/shared/constants'
import { createRpcPeer } from '../src/shared/rpc'
import { TestChatProvider } from './fixtures/chat-provider'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected client event did not arrive')
    await delay(5)
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-client-routing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await simpleGit(directory).init(['--initial-branch=main'])
  const config = join(directory, 'server.yaml')
  await writeFile(
    config,
    stringify({
      host: '127.0.0.1',
      port: 0,
      projects: [{ mainWorktreePath: directory }],
      vscode: { settingsFile: join(directory, 'settings.json') },
    }),
  )
  const vscode = new ProcessVscodeServerFactory(
    {
      dataDirectory: directory,
      prepare: async () => ({ node: '', entrypoint: '' }),
    },
    {
      launch: async () => {
        throw new Error('Test launch failure')
      },
    },
  )
  const server = await startServer(config, vscode, [new TestChatProvider()])
  t.after(() => server.close())
  const url = `ws://127.0.0.1:${server.port}/rpc`
  const connect = async (methods: object) => {
    const socket = new WebSocket(url, { maxPayload: MAX_RPC_PAYLOAD_BYTES })
    const requests: string[] = []
    // Inspect the wire as well as handlers: an unsupported event must never be sent.
    socket.on('message', (data) => {
      const { json: message } = JSON.parse(data.toString())
      if (message.t === 'q') requests.push(message.m)
    })
    const rpc = createRpcPeer<ServerMethods, object>(socket, methods)
    t.after(() => socket.terminate())
    await once(socket, 'open')
    return { socket, rpc, requests }
  }
  const report = async (title: string, fields: Partial<Chat> = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/chats/report/test`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'test',
          sessionId: 'one',
          worktreePath: directory,
          title,
          status: 'idle',
          mtime: Date.now(),
          pid: process.pid,
          ...fields,
        }),
      },
    )
    assert.equal(response.status, 204)
  }
  return { connect, report, vscode, directory, url }
}

const desktopMethods: DesktopClientMethods = {
  getClientInfo: () => ({ kind: 'desktop', name: 'test', version: '1' }),
  chatTurnFinished: () => {},
  chatsChanged: () => {},
  settingsChanged: () => {},
  worktreesChanged: () => {},
}

test('working to idle transitions notify desktops with the chat ID, current title, worktree basename and description', async (t) => {
  const f = await fixture(t)
  const notifications: Parameters<DesktopClientMethods['chatTurnFinished']>[] =
    []
  const desktop = await f.connect({
    ...desktopMethods,
    chatTurnFinished: (
      id: string,
      title: string,
      worktreeBasename: string,
      description: string,
    ) => {
      notifications.push([id, title, worktreeBasename, description])
    },
  })
  const extension = await f.connect({
    getClientInfo: () => ({ kind: 'extension', name: 'test', version: '1' }),
    chatsChanged: () => {},
  })
  await waitFor(() => desktop.requests.includes('worktreesChanged'))
  await waitFor(() => extension.requests.includes('chatsChanged'))

  await f.report('Idle')
  await f.report('Working', { status: 'working' })
  await f.report('Still working', { status: 'working' })
  await desktop.rpc.getServerInfo()
  assert.deepEqual(notifications, [])

  await f.report('Finished', { description: 'Implemented notifications.' })
  await waitFor(() => notifications.length === 1)
  assert.deepEqual(notifications, [
    [
      'test:one',
      'Finished',
      basename(f.directory),
      'Implemented notifications.',
    ],
  ])
  await f.report('Still idle')
  await desktop.rpc.getServerInfo()
  assert.equal(notifications.length, 1)

  await f.report('Next turn', { status: 'working' })
  await f.report('Another chat', { sessionId: 'two', status: 'working' })
  await f.report('Another chat finished', { sessionId: 'two' })
  await f.report('Next turn finished', { description: 'Updated the tests.' })
  await waitFor(() => notifications.length === 3)
  assert.deepEqual(notifications.slice(1), [
    ['test:two', 'Another chat finished', basename(f.directory), ''],
    [
      'test:one',
      'Next turn finished',
      basename(f.directory),
      'Updated the tests.',
    ],
  ])
  await extension.rpc.getServerInfo()
  assert.ok(!extension.requests.includes('chatTurnFinished'))
})

test('descriptions are stored as previews and sent unchanged to extensions', async (t) => {
  const f = await fixture(t)
  const snapshots: Record<string, Chat>[] = []
  const methods: ExtensionClientMethods = {
    getClientInfo: () => ({
      kind: 'extension',
      name: 'test',
      version: '1',
    }),
    chatsChanged: (snapshot) => {
      snapshots.push(snapshot)
    },
  }
  const extension = await f.connect(methods)
  await waitFor(() => snapshots.length === 1)
  const title = 'Title'.repeat(1000)
  const description = 'a'.repeat(600_000)
  await f.report(title, { description })
  await waitFor(() => snapshots.length === 2)
  const stored = (await extension.rpc.getChats())['test:one']
  assert.equal(stored.description, 'a'.repeat(64_000))
  assert.equal(stored.title, title)
  assert.deepEqual(snapshots[1]['test:one'], stored)
  await f.report(title, { sessionId: 'two', description: 'b'.repeat(600_000) })
  await waitFor(() => snapshots.length === 3)
  assert.equal(snapshots[2]['test:two'].description, 'b'.repeat(64_000))
  assert.equal(snapshots[2]['test:two'].title, title)
  await extension.rpc.getServerInfo()
  assert.equal(extension.socket.readyState, WebSocket.OPEN)

  const closed = once(extension.socket, 'close')
  extension.socket.terminate()
  await closed
  const reconnected = await f.connect(methods)
  await waitFor(() => snapshots.length === 4)
  assert.deepEqual(snapshots[3], snapshots[2])
  // Count Unicode code points so a preview never splits a surrogate pair.
  const unicode = 'a'.repeat(63_999) + '\u{1F600}'
  await f.report(title, { description: unicode + 'extra' })
  await waitFor(() => snapshots.length === 5)
  assert.equal(snapshots[4]['test:one'].description, unicode)
  assert.equal(
    (await reconnected.rpc.getChats())['test:one'].description,
    unicode,
  )
  await f.report('Undefined', { sessionId: 'undefined' })
  await f.report('Empty', { sessionId: 'empty', description: '' })
  await waitFor(() => snapshots.length === 7)
  assert.equal(snapshots[6]['test:undefined'].description, undefined)
  assert.equal(snapshots[6]['test:empty'].description, '')
  await reconnected.rpc.getServerInfo()
  assert.equal(reconnected.socket.readyState, WebSocket.OPEN)
})

test('notifications inherit stored description previews without disconnecting the desktop', async (t) => {
  const f = await fixture(t)
  const notifications: Parameters<DesktopClientMethods['chatTurnFinished']>[] =
    []
  const desktop = await f.connect({
    ...desktopMethods,
    chatTurnFinished: (
      id: string,
      title: string,
      worktreeBasename: string,
      description: string,
    ) => {
      notifications.push([id, title, worktreeBasename, description])
    },
  })
  await waitFor(() => desktop.requests.includes('worktreesChanged'))
  await f.report('Working', {
    status: 'working',
    description: 'a'.repeat(600_000),
  })
  const title = 't'.repeat(600_000)
  await f.report(title)
  await waitFor(() => notifications.length === 1)
  assert.deepEqual(notifications, [
    ['test:one', title, basename(f.directory), 'a'.repeat(64_000)],
  ])
  const stored = (await desktop.rpc.getChats())['test:one']
  assert.equal(stored.description, 'a'.repeat(64_000))
  assert.equal(stored.title, title)
  await desktop.rpc.getServerInfo()
  assert.equal(desktop.socket.readyState, WebSocket.OPEN)
})

test('chat snapshots reach both kinds while worktree and settings snapshots reach only desktops', async (t) => {
  const f = await fixture(t)
  const snapshots: Record<string, Chat>[] = []
  const extensionMethods: ExtensionClientMethods = {
    getClientInfo: () => ({
      kind: 'extension',
      name: 'test',
      version: '1',
    }),
    chatsChanged: (snapshot) => {
      snapshots.push(snapshot)
    },
  }
  const desktop = await f.connect(desktopMethods)
  const extension = await f.connect(extensionMethods)
  await waitFor(() => desktop.requests.length === 4 && snapshots.length === 1)
  assert.deepEqual(snapshots, [{}])
  await f.report('First')
  await waitFor(() => snapshots.length === 2)
  await desktop.rpc.writeSettings('{"editor.fontSize": 18}')
  await desktop.rpc.refreshWorktrees()
  await desktop.rpc.ensureVscodeServer(f.directory)
  await waitFor(
    () =>
      desktop.requests.filter((name) => name === 'worktreesChanged').length ===
      5,
  )
  // Round trips flush prior events on both sockets before testing exclusions.
  await Promise.all([
    desktop.rpc.getServerInfo(),
    extension.rpc.getServerInfo(),
  ])
  assert.deepEqual(
    new Set(desktop.requests),
    new Set([
      'getClientInfo',
      'chatsChanged',
      'settingsChanged',
      'worktreesChanged',
    ]),
  )
  assert.deepEqual(extension.requests, [
    'getClientInfo',
    'chatsChanged',
    'chatsChanged',
  ])
  for (const name of ['settingsChanged', 'worktreesChanged'])
    assert.equal(
      desktop.requests.filter((request) => request === name).length,
      name === 'settingsChanged' ? 2 : 5,
    )

  const closed = once(extension.socket, 'close')
  extension.socket.terminate()
  await closed
  await f.report('While disconnected')
  const reconnected = await f.connect(extensionMethods)
  await waitFor(() => snapshots.length === 3)
  assert.equal(snapshots[2]['test:one'].title, 'While disconnected')
  await f.report('After reconnect')
  await waitFor(() => snapshots.length === 4)
  assert.equal(snapshots[3]['test:one'].title, 'After reconnect')
  assert.deepEqual(reconnected.requests, [
    'getClientInfo',
    'chatsChanged',
    'chatsChanged',
  ])
  await desktop.rpc.getServerInfo()
  assert.ok(desktop.requests.includes('chatsChanged'))
})

test('identification gates snapshots and the first snapshot includes intervening changes', async (t) => {
  const f = await fixture(t)
  const identified = deferred<ClientInfo>()
  const snapshots: Record<string, Chat>[] = []
  const extension = await f.connect({
    getClientInfo: () => identified.promise,
    chatsChanged: (snapshot: Record<string, Chat>) => {
      snapshots.push(snapshot)
    },
  })
  await waitFor(() => extension.requests.includes('getClientInfo'))
  await f.report('During identification')
  await extension.rpc.refreshWorktrees()
  await extension.rpc.getServerInfo()
  assert.deepEqual(extension.requests, ['getClientInfo'])
  identified.resolve({
    kind: 'extension',
    name: 'test',
    version: '1',
  })
  await waitFor(() => snapshots.length === 1)
  assert.equal(snapshots[0]['test:one'].title, 'During identification')
  await f.report('After identification')
  await waitFor(() => snapshots.length === 2)
})

for (const failure of ['missing', 'invalid', 'rejected', 'timeout'] as const) {
  test(
    `failed identification closes the connection without snapshots: ${failure}`,
    { timeout: RPC_TIMEOUT_MS + 5000 },
    async (t) => {
      const f = await fixture(t)
      const methods =
        failure === 'missing'
          ? {}
          : {
              getClientInfo: () => {
                if (failure === 'rejected')
                  throw new Error('Identification failed')
                if (failure === 'timeout') return new Promise(() => {})
                return { kind: 'unknown', name: 'test', version: '1' }
              },
            }
      const client = await f.connect(methods)
      await once(client.socket, 'close')
      assert.deepEqual(client.requests, ['getClientInfo'])
      // Other connections and broadcasts remain usable.
      const snapshots: Record<string, Chat>[] = []
      const healthy = await f.connect({
        getClientInfo: () => ({
          kind: 'extension',
          name: 'test',
          version: '1',
        }),
        chatsChanged: (snapshot: Record<string, Chat>) => {
          snapshots.push(snapshot)
        },
      })
      await waitFor(() => snapshots.length === 1)
      await f.report('Healthy')
      await healthy.rpc.getServerInfo()
      assert.equal(snapshots.at(-1)!['test:one'].title, 'Healthy')
    },
  )
}

test('disconnecting during identification does not register a client later', async (t) => {
  const f = await fixture(t)
  const identified = deferred<ClientInfo>()
  const client = await f.connect({ getClientInfo: () => identified.promise })
  await waitFor(() => client.requests.length === 1)
  const closed = once(client.socket, 'close')
  client.socket.terminate()
  await closed
  identified.resolve({
    kind: 'extension',
    name: 'test',
    version: '1',
  })
  await f.report('After disconnect')
  assert.deepEqual(client.requests, ['getClientInfo'])
})
