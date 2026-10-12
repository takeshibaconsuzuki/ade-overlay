import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { stringify } from 'yaml'
import { startServer } from '../src/server/application'
import { ProcessVscodeServerManager } from '../src/server/vscode-manager'
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
  const config = join(directory, 'server.yaml')
  await writeFile(
    config,
    stringify({
      host: '127.0.0.1',
      port: 0,
      vscode: { settingsFile: join(directory, 'settings.json') },
    }),
  )
  const vscode = new ProcessVscodeServerManager(
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
      const message = JSON.parse(data.toString())
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
  settingsChanged: () => {},
  worktreesChanged: () => {},
  vscodeServersChanged: () => {},
}

test('large descriptions are previewed without disconnecting extensions or truncating stored reports', async (t) => {
  const f = await fixture(t)
  const snapshots: Record<string, Chat>[] = []
  const methods: ExtensionClientMethods = {
    getClientInfo: () => ({ kind: 'extension', name: 'test', version: '1' }),
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
  assert.equal(stored.description, description)
  assert.deepEqual(snapshots[1]['test:one'], {
    ...stored,
    description: 'a'.repeat(64_000),
  })
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
  await f.report('Undefined', { sessionId: 'undefined' })
  await f.report('Empty', { sessionId: 'empty', description: '' })
  await waitFor(() => snapshots.length === 7)
  assert.equal(snapshots[6]['test:undefined'].description, undefined)
  assert.equal(snapshots[6]['test:empty'].description, '')
  await reconnected.rpc.getServerInfo()
  assert.equal(reconnected.socket.readyState, WebSocket.OPEN)
})

test('snapshots are routed exclusively to the identified client kind, including reconnects', async (t) => {
  const f = await fixture(t)
  const snapshots: Record<string, Chat>[] = []
  const extensionMethods: ExtensionClientMethods = {
    getClientInfo: () => ({ kind: 'extension', name: 'test', version: '1' }),
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
  f.vscode.ensure(f.directory, f.url)
  await waitFor(
    () =>
      desktop.requests.filter((name) => name === 'vscodeServersChanged')
        .length === 3,
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
      'settingsChanged',
      'worktreesChanged',
      'vscodeServersChanged',
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
      2,
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
  assert.ok(!desktop.requests.includes('chatsChanged'))
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
  identified.resolve({ kind: 'extension', name: 'test', version: '1' })
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
  identified.resolve({ kind: 'extension', name: 'test', version: '1' })
  await f.report('After disconnect')
  assert.deepEqual(client.requests, ['getClientInfo'])
})
