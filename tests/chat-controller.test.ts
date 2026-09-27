import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { ExtensionChatMessage } from '../src/shared/chats.ts'

test(
  'late restored PIDs resynchronize without terminal events and stop after closure/disposal',
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
          external: ['ws', /^node:/],
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
    sockets.on('connection', (socket) =>
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as ExtensionChatMessage
        messages.push(message)
        if (message.type === 'inventory') {
          socket.send(
            JSON.stringify({
              type: 'result',
              id: message.id,
              terminals: message.terminals,
            }),
          )
          if (
            message.terminals.some(
              (terminal) => terminal.terminalId === 'restored',
            )
          )
            socket.send(
              JSON.stringify({
                type: 'focus',
                id: 'late-focus',
                terminalId: 'restored',
              }),
            )
        }
      }),
    )
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
          throw new Error('Timed out waiting for PID inventory/focus')
        await delay(10)
      }
    }
    for (const lifecycle of ['live', 'closed', 'disposed']) {
      messages.length = 0
      let resolvePid!: (pid: number) => void
      const terminal = {
        name: 'Restored',
        processId: new Promise<number>((resolve) => {
          resolvePid = resolve
        }),
        show() {
          vscode.window.activeTerminal = terminal
        },
      }
      vscode.window.terminals = [terminal]
      const controller = new ChatController({
        workspaceState: {
          get: () => ({
            10: { pid: 10, terminalId: 'restored', startedAt: 'shell-start' },
          }),
          update: async () => {},
        },
      })
      try {
        await until(() =>
          messages.some((message) => message.type === 'inventory'),
        )
        assert.deepEqual(
          messages.find((message) => message.type === 'inventory')?.terminals,
          [],
        )
        if (lifecycle === 'closed') {
          vscode.window.terminals = []
          vscode.closed.fire(terminal)
        }
        if (lifecycle === 'disposed') controller.dispose()
        resolvePid(10)
        if (lifecycle === 'live') {
          await until(() =>
            messages.some((message) => message.type === 'focused'),
          )
          assert.equal(vscode.window.activeTerminal, terminal)
          const focused = messages.find((message) => message.type === 'focused')
          assert.equal(focused?.error, undefined)
        } else {
          await delay(100)
          assert.equal(
            messages.some(
              (message) =>
                message.type === 'inventory' && message.terminals.length,
            ),
            false,
          )
        }
      } finally {
        controller.dispose()
      }
      await delay(20)
    }
  },
)
