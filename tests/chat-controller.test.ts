import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { builtinModules } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import type { ExtensionChatMessage } from '../src/shared/chats.ts'

test(
  'focus waits locally for restoration, supersedes pending targets and cancels cleanly',
  { timeout: 12_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ade-chat-controller-'))
    t.after(async () => {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    })
    const stub = new URL('./fixtures/chat-vscode.mjs', import.meta.url).href
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'vscode-fixture',
          resolveId: (id) =>
            id === 'vscode' ? { id: stub, external: true } : undefined,
        },
      ],
      resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
      build: {
        target: 'es2022',
        outDir: root,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: fileURLToPath(
            new URL(
              '../extensions/ade-terminals/src/chats.ts',
              import.meta.url,
            ),
          ),
          formats: ['es'],
          fileName: () => 'chats.mjs',
        },
        rollupOptions: {
          external: ['ws', /^node:/, ...builtinModules],
          output: { paths: { ws: import.meta.resolve('ws') } },
        },
      },
    })
    const vscode = await import(stub)
    const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(sockets, 'listening')
    t.after(async () => {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
    })
    const messages: ExtensionChatMessage[] = []
    let peer: WebSocket | undefined
    sockets.on('connection', (socket) => {
      peer = socket
      socket.on('message', (data) => {
        messages.push(JSON.parse(data.toString()) as ExtensionChatMessage)
      })
    })
    const originalEnv = process.env
    t.after(() => {
      process.env = originalEnv
    })
    process.env = {
      ...originalEnv,
      ADE_CHAT_ENDPOINT: `http://127.0.0.1:${(sockets.address() as AddressInfo).port}`,
      ADE_CHAT_EXTENSION_TOKEN: 'test-control',
    }
    const { ChatController } = await import(
      pathToFileURL(join(root, 'chats.mjs')).href
    )
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 2500
      while (!check()) {
        if (Date.now() > deadline)
          throw new Error('Timed out waiting for focus acknowledgement')
        await delay(10)
      }
    }
    const terminal = (id: string) => ({
      creationOptions: { env: { ADE_TERMINAL_ID: id } },
      // New terminals are immediately identifiable, even before their PID arrives.
      processId: new Promise<number>(() => {}),
      shows: 0,
      show() {
        this.shows++
        vscode.window.activeTerminal = this
      },
    })
    const result = (id: string) =>
      messages.find(
        (message) => message.type === 'focused' && message.id === id,
      )
    const saved = {
      101: { pid: 101, startedAt: 'original', terminalId: 'b' },
      102: { pid: 102, startedAt: 'old', terminalId: 'b' },
    }
    const controller = new ChatController(
      {
        workspaceState: {
          get: () => saved,
          update: async () => {},
        },
      },
      async () =>
        new Map([
          [101, { pid: 101, startedAt: 'original' }],
          [102, { pid: 102, startedAt: 'reused' }],
        ]),
    )
    t.after(() => controller.dispose())
    let placements = 0
    controller.coordinateFocus = async (operation: () => Promise<unknown>) => {
      placements++
      return operation()
    }
    vscode.window.terminals = []
    await until(() => !!peer)
    assert.equal(
      messages.length,
      0,
      'connecting needs no terminal announcements',
    )

    peer!.send(JSON.stringify({ type: 'focus', id: 'first', terminalId: 'a' }))
    await delay(80)
    assert.equal(result('first'), undefined)
    assert.equal(placements, 0, 'restoration does not hold the placement queue')
    peer!.send(JSON.stringify({ type: 'focus', id: 'second', terminalId: 'b' }))
    await until(() => !!result('first'))
    const superseded = result('first')
    assert.ok(superseded?.type === 'focused' && superseded.error)
    const a = terminal('a')
    vscode.window.terminals = [a]
    vscode.opened.fire(a)
    await delay(80)
    assert.equal(a.shows, 0, 'late restoration cannot steal focus')
    const reused = {
      ...terminal(''),
      creationOptions: {},
      processId: Promise.resolve(102),
    }
    vscode.window.terminals.push(reused)
    vscode.opened.fire(reused)
    await delay(80)
    assert.equal(
      reused.shows,
      0,
      'a reused shell PID cannot recover an old terminal ID',
    )
    const b = {
      ...terminal(''),
      creationOptions: {},
      processId: Promise.resolve(101),
    }
    vscode.window.terminals.push(b)
    vscode.opened.fire(b)
    await until(() => !!result('second'))
    assert.deepEqual(result('second'), { type: 'focused', id: 'second' })
    assert.equal(vscode.window.activeTerminal, b)

    peer!.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: {
          revision: 1,
          chats: [
            {
              id: 'chat-b',
              terminalId: 'b',
              provider: 'codex',
              sessionId: 'session',
              project: '/project',
              path: '/project',
              activity: 'idle',
            },
          ],
        },
      }),
    )
    await until(() => controller.getSnapshot().revision === 1)
    controller.selectTerminal(b)
    assert.equal(controller.getActiveChatId(), 'chat-b')
    vscode.window.terminals = [a]
    vscode.closed.fire(b)
    assert.equal(controller.getActiveChatId(), undefined)

    // Cancellation must also be checked after waiting for a busy placement queue.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    controller.coordinateFocus = async (operation: () => Promise<unknown>) => {
      placements++
      await held
      return operation()
    }
    const previousPlacements = placements
    peer!.send(JSON.stringify({ type: 'focus', id: 'held', terminalId: 'a' }))
    await until(() => placements > previousPlacements)
    peer!.send(JSON.stringify({ type: 'cancel-focus', id: 'held' }))
    await delay(30)
    release()
    await until(() => !!result('held'))
    assert.equal(a.shows, 0)

    peer!.send(
      JSON.stringify({ type: 'focus', id: 'timeout', terminalId: 'missing' }),
    )
    await delay(50)
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8100 })
    await delay(80)
    t.mock.timers.reset()
    await until(() => !!result('timeout'))
    const timedOut = result('timeout')
    assert.ok(timedOut?.type === 'focused' && timedOut.error)

    peer!.send(
      JSON.stringify({ type: 'focus', id: 'disconnect', terminalId: 'c' }),
    )
    await delay(50)
    peer!.terminate()
    await delay(50)
    const c = terminal('c')
    vscode.window.terminals.push(c)
    await delay(80)
    assert.equal(c.shows, 0, 'disconnected requests cannot focus later')
    await until(() => peer?.readyState === 1)
    peer!.send(
      JSON.stringify({ type: 'focus', id: 'reconnected', terminalId: 'c' }),
    )
    await until(() => !!result('reconnected'))
    assert.equal(c.shows, 1, 'reconnect can focus without announcing terminals')
    peer!.send(
      JSON.stringify({ type: 'focus', id: 'disposed', terminalId: 'd' }),
    )
    await delay(50)
    controller.dispose()
    const d = terminal('d')
    vscode.window.terminals.push(d)
    await delay(80)
    assert.equal(d.shows, 0)
    assert.ok(messages.every((message) => message.type === 'focused'))
  },
)

test(
  'bundled controller keeps control credentials out of scanner initialization and subprocesses',
  { skip: process.platform !== 'win32', timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ade-chat-credentials-'))
    t.after(async () => {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    })
    await build({
      configFile: false,
      logLevel: 'silent',
      resolve: {
        conditions: ['node'],
        mainFields: ['module', 'main'],
        alias: {
          vscode: fileURLToPath(
            new URL('./fixtures/chat-vscode.mjs', import.meta.url),
          ),
        },
      },
      build: {
        target: 'node22',
        outDir: root,
        emptyOutDir: false,
        lib: {
          entry: fileURLToPath(
            new URL(
              '../extensions/ade-terminals/src/chats.ts',
              import.meta.url,
            ),
          ),
          formats: ['cjs'],
          fileName: () => 'chats.cjs',
        },
        rollupOptions: {
          external: [
            /^node:/,
            ...builtinModules,
            'bufferutil',
            'utf-8-validate',
          ],
        },
      },
    })
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL('./fixtures/chat-credentials.cjs', import.meta.url),
        ),
        join(root, 'chats.cjs'),
      ],
      { windowsHide: true, timeout: 15_000 },
    )
  },
)
