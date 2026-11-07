import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { stringify } from 'yaml'
import { startServer } from '../src/server/application'
import { CodexChatProvider } from '../src/server/chat-providers/codex/provider'
import type {
  ChatMessage,
  ChatProvider,
  ChatReport,
  ChatSession,
} from '../src/server/chat-provider'
import { createCodexMetadata } from './fixtures/codex-metadata'
import { ProcessVscodeServerFactory } from '../src/server/vscode-server'
import type {
  Chat,
  ExtensionClientMethods,
  ServerMethods,
} from '../src/shared/api'
import { createRpcPeer } from '../src/shared/rpc'
import { TestChatProvider } from './fixtures/chat-provider'
import {
  emptyChatHistory,
  LocalChatHistoryIndexer,
} from './fixtures/chat-history'
import { ChatHistory } from '../src/server/chat-history'

test('chat commands are isolated by provider and read from the latest configuration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-commands-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = join(directory, 'server.yaml')
  const options = {
    host: '127.0.0.1',
    port: 0,
    vscode: { settingsFile: join(directory, 'settings.json') },
  }
  await writeFile(config, stringify(options))
  const vscode = new ProcessVscodeServerFactory(
    {
      dataDirectory: directory,
      prepare: async () => ({ node: '', entrypoint: '' }),
    },
    {
      launch: async () => {
        throw new Error('Unexpected launch')
      },
    },
  )
  const server = await startServer(
    config,
    vscode,
    [new TestChatProvider('codex'), new TestChatProvider('example')],
    emptyChatHistory(),
  )
  t.after(() => server.close())
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`)
  t.after(() => socket.terminate())
  const rpc = createRpcPeer<ServerMethods, ExtensionClientMethods>(socket, {
    getClientInfo: () => ({ kind: 'extension', name: 'test', version: '1' }),
    chatsChanged() {},
    chatHistoryChanged() {},
  })
  await once(socket, 'open')
  assert.deepEqual(await rpc.getChatProviders(), [
    { id: 'codex', name: 'Codex' },
    { id: 'example', name: 'Example' },
  ])
  assert.equal(await rpc.getChatCommand('codex'), 'codex')
  assert.equal(await rpc.getChatCommand('example'), 'example')
  const sessionId = '01a1b36c-52c9-7c83-81f4-4bd114417b85'
  assert.equal(
    await rpc.getChatCommand('codex', sessionId),
    `codex --resume ${sessionId}`,
  )
  // Session IDs are restricted because they become part of a shell command line.
  await assert.rejects(rpc.getChatCommand('codex', `${sessionId}; exit`))
  const commands = {
    codex: { command: 'codex --model custom-model' },
    example: { command: 'example --flag "two words"' },
  }
  const waitForCommand = async (expected: string) => {
    const deadline = Date.now() + 5000
    while ((await rpc.getChatCommand('codex')) !== expected) {
      assert.ok(Date.now() < deadline, 'Expected command reload')
      await delay(25)
    }
  }
  await writeFile(config, stringify({ ...options, chatProviders: commands }))
  await waitForCommand(commands.codex.command)
  assert.equal(await rpc.getChatCommand('example'), commands.example.command)
  await assert.rejects(
    rpc.getChatCommand('unconfigured'),
    /Unknown chat provider/,
  )

  await writeFile(
    config,
    stringify({
      ...options,
      chatProviders: { ...commands, codex: { command: 'codex --resume' } },
    }),
  )
  await waitForCommand('codex --resume')
  assert.equal(await rpc.getChatCommand('example'), commands.example.command)

  await writeFile(
    config,
    stringify({ ...options, chatProviders: { codex: {} } }),
  )
  await waitForCommand('codex')
  assert.equal(await rpc.getChatCommand('example'), 'example')
})

test('startup installs hooks and accepts raw HTTP reports from any worktree', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-rpc-'))
  const config = join(directory, 'server.yaml')
  await writeFile(
    config,
    stringify({
      host: '127.0.0.1',
      port: 0,
      vscode: { settingsFile: join(directory, 'settings.json') },
    }),
  )
  const entry = join(directory, 'hook.cjs')
  await writeFile(entry, '')
  const vscode = new ProcessVscodeServerFactory(
    {
      dataDirectory: directory,
      prepare: async () => ({ node: '', entrypoint: '' }),
    },
    {
      launch: async () => {
        throw new Error('Unexpected launch')
      },
    },
  )
  const metadata = createCodexMetadata(directory)
  t.after(async () => {
    metadata.close()
    await rm(directory, { recursive: true, force: true })
  })
  metadata
    .prepare(
      'INSERT INTO threads (id, title, first_user_message, preview) VALUES (?, ?, ?, ?)',
    )
    .run('first', 'Saved Codex name', 'Original request', 'Stored preview')
  const server = await startServer(
    config,
    vscode,
    [new CodexChatProvider([process.execPath, entry], directory)],
    emptyChatHistory(),
  )
  t.after(() => server.close())
  const url = `ws://127.0.0.1:${server.port}/rpc`
  const endpoint = `http://127.0.0.1:${server.port}/chats/report/codex`
  const post = (payload: unknown, provider = 'codex') =>
    fetch(`http://127.0.0.1:${server.port}/chats/report/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  const socket = new WebSocket(url)
  const snapshots: Record<string, Chat>[] = []
  const rpc = createRpcPeer<ServerMethods, ExtensionClientMethods>(socket, {
    getClientInfo: () => ({
      kind: 'extension',
      name: 'test',
      version: '1',
    }),
    chatsChanged: (snapshot) => {
      snapshots.push(snapshot)
    },
    chatHistoryChanged() {},
  })
  t.after(() => socket.terminate())
  await once(socket, 'open')
  assert.deepEqual(await rpc.getChats(), {})
  await waitFor(() => snapshots.length === 1)
  assert.deepEqual(snapshots, [{}])
  // The reporter's worktree identifies the chat, wherever the agent works.
  const event = {
    session_id: 'first',
    cwd: join(directory, 'agent-worktree'),
    worktreePath: join(directory, 'terminal-worktree'),
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Fix startup\nDetails',
    pid: process.pid,
  }
  const receivedAfter = Date.now()
  assert.equal((await post({ ...event, mtime: 1 })).status, 204)
  let chats = await rpc.getChats()
  assert.deepEqual(snapshots.at(-1), chats)
  assert.equal(snapshots.length, 2)
  // A newly connected extension receives existing chats without waiting for another report.
  const secondSocket = new WebSocket(url)
  const secondSnapshots: Record<string, Chat>[] = []
  const secondRpc = createRpcPeer<ServerMethods, ExtensionClientMethods>(
    secondSocket,
    {
      getClientInfo: () => ({
        kind: 'extension',
        name: 'test',
        version: '1',
      }),
      chatsChanged: (snapshot) => {
        secondSnapshots.push(snapshot)
      },
      chatHistoryChanged() {},
    },
  )
  t.after(() => secondSocket.terminate())
  await once(secondSocket, 'open')
  assert.deepEqual(await secondRpc.getChats(), chats)
  await waitFor(() => secondSnapshots.length === 1)
  assert.deepEqual(secondSnapshots, [chats])
  assert.deepEqual(chats['codex:first'], {
    providerId: 'codex',
    sessionId: 'first',
    worktreePath: event.worktreePath,
    title: 'Saved Codex name',
    description: 'Fix startup\nDetails',
    status: 'working',
    mtime: chats['codex:first'].mtime,
    lastActivityAt: chats['codex:first'].mtime,
    pid: process.pid,
    terminalId: undefined,
  })
  assert.ok(chats['codex:first'].mtime >= receivedAfter)
  assert.equal((await post({ ...event, session_id: 'second' })).status, 204)
  await post({
    ...event,
    hook_event_name: 'Stop',
    prompt: undefined,
    last_assistant_message: 'Done',
  })
  chats = await rpc.getChats()
  assert.equal(Object.keys(chats).length, 2)
  assert.deepEqual(snapshots.at(-1), chats)
  await secondRpc.getChats()
  assert.deepEqual(secondSnapshots.at(-1), chats)
  assert.equal(secondSnapshots.length, 3)
  assert.equal(chats['codex:first'].status, 'idle')
  assert.equal(chats['codex:first'].description, 'Done')
  metadata
    .prepare('UPDATE threads SET title = ? WHERE id = ?')
    .run('Renamed in Codex', 'first')
  assert.equal(
    (
      await post({
        ...event,
        hook_event_name: 'Stop',
        prompt: undefined,
        last_assistant_message: 'Updated answer',
      })
    ).status,
    204,
  )
  assert.equal((await rpc.getChats())['codex:first'].title, 'Renamed in Codex')
  assert.equal((await rpc.getChats())['codex:first'].status, 'idle')
  await assert.rejects(rpc.$call('reportChat' as 'getChats'), /not found/)
  assert.equal((await post({ session_id: 'bad' })).status, 400)
  assert.equal((await post(event, 'unknown')).status, 400)
  assert.equal((await fetch(endpoint)).status, 404)
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(1024 * 1024 + 1),
      })
    ).status,
    413,
  )
  await post({ ...event, hook_event_name: 'SessionEnd', prompt: undefined })
  chats = await rpc.getChats()
  assert.deepEqual(Object.keys(chats), ['codex:second'])
  assert.deepEqual(snapshots.at(-1), chats)
  await secondRpc.getChats()
  assert.deepEqual(secondSnapshots.at(-1), chats)
  const notifications = snapshots.length
  await post({ ...event, session_id: 'unseen', hook_event_name: 'SessionEnd' })
  assert.deepEqual(await rpc.getChats(), chats)
  assert.equal(snapshots.length, notifications)
  // A missed resume hook does not prevent the next prompt from restoring the chat.
  await post(event)
  chats = await rpc.getChats()
  assert.equal(chats['codex:first'].status, 'working')
  assert.equal(chats['codex:first'].description, event.prompt)
  assert.deepEqual(snapshots.at(-1), chats)
  await secondRpc.getChats()
  assert.deepEqual(secondSnapshots.at(-1), chats)
  await server.close()
  await assert.rejects(post(event))
})

test('extensions search chat history and hear when updates finish', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-history-rpc-'))
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
  const vscode = new ProcessVscodeServerFactory(
    {
      dataDirectory: directory,
      prepare: async () => ({ node: '', entrypoint: '' }),
    },
    {
      launch: async () => {
        throw new Error('Unexpected launch')
      },
    },
  )
  const provider = new TestChatProvider()
  const server = await startServer(
    config,
    vscode,
    [provider],
    new ChatHistory(
      join(directory, 'history.sqlite'),
      new LocalChatHistoryIndexer(join(directory, 'history.sqlite'), [
        provider,
      ]),
    ),
  )
  t.after(() => server.close())
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`)
  t.after(() => socket.terminate())
  let changes = 0
  const rpc = createRpcPeer<ServerMethods, ExtensionClientMethods>(socket, {
    getClientInfo: () => ({ kind: 'extension', name: 'test', version: '1' }),
    chatsChanged() {},
    chatHistoryChanged() {
      changes++
    },
  })
  await once(socket, 'open')
  // The startup update finds no sessions.
  const deadline = Date.now() + 5000
  while ((await rpc.searchChatHistory('')).indexing) {
    assert.ok(Date.now() < deadline, 'Expected the startup update to finish')
    await delay(25)
  }
  provider.sessions = [
    { sessionId: 'one', title: 'One', cwd: directory, modifiedAt: 1 },
  ]
  provider.messages.set('one', ['Find the bug'])
  const now = Date.now()
  // A search once the index is stale starts an update.
  const clock = t.mock.method(Date, 'now', () => now + 10_000)
  const before = changes
  assert.deepEqual(await rpc.searchChatHistory('bug'), {
    chats: [],
    indexing: true,
  })
  clock.mock.restore()
  await waitFor(() => changes > before)
  const { chats } = await rpc.searchChatHistory('bug')
  assert.deepEqual(
    chats.map(({ providerId, sessionId, title, excerpt }) => ({
      providerId,
      sessionId,
      title,
      excerpt,
    })),
    [
      {
        providerId: 'test',
        sessionId: 'one',
        title: 'One',
        excerpt: 'Find the bug',
      },
    ],
  )
})

class FailingProvider implements ChatProvider {
  readonly id = 'failing'
  readonly name = 'Failing'
  readonly defaultCommand = 'failing'
  async readReport(): Promise<ChatReport> {
    throw new Error('Unexpected report')
  }
  async install(): Promise<void> {
    throw new Error('Hook installation failed')
  }
  async listSessions(): Promise<ChatSession[]> {
    return []
  }
  async *readMessages(): AsyncGenerator<ChatMessage> {}
  resumeCommand(command: string): string {
    return command
  }
}

test('hook installation failure rolls back server startup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-failure-'))
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
  const vscode = new ProcessVscodeServerFactory(
    {
      dataDirectory: directory,
      prepare: async () => ({ node: '', entrypoint: '' }),
    },
    {
      launch: async () => {
        throw new Error('Unexpected launch')
      },
    },
  )
  const hooks = new FailingProvider()
  await assert.rejects(
    startServer(config, vscode, [hooks], emptyChatHistory()),
    /Hook installation failed/,
  )
})

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected snapshot did not arrive')
    await delay(5)
  }
}
