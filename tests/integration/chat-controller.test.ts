import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { builtinModules } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'
import type { Socket } from 'socket.io'
import { socketServer } from '../helpers/socket.ts'
import { chatEvents } from '../../src/shared/chats.ts'
import { sendEvent, listenEvent } from '../../src/shared/rpc.ts'

test(
  'focus waits locally for restoration, supersedes pending targets and cancels cleanly',
  { timeout: 12_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ade-chat-controller-'))
    t.after(async () => {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    })
    const stub = new URL('../fixtures/chat-vscode.mjs', import.meta.url).href
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
              '../../extensions/ade-terminals/src/chats.ts',
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
    const messages: { id: string; error?: string }[] = []
    let peer: Socket | undefined
    const fixture = await socketServer(
      t,
      (socket) => {
        peer = socket
        listenEvent(
          socket,
          chatEvents.focused,
          (message) => messages.push(message),
          () => {
            throw new Error('Invalid focus result')
          },
        )
      },
      { path: '/extension' },
    )
    const originalEnv = process.env
    t.after(() => {
      process.env = originalEnv
    })
    process.env = {
      ...originalEnv,
      ADE_CHAT_ENDPOINT: fixture.url
        .replace('ws:', 'http:')
        .replace('/extension', ''),
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
    const terminal = () => ({
      shows: 0,
      show() {
        this.shows++
        vscode.window.activeTerminal = this
      },
    })
    const result = (id: string) => messages.find((message) => message.id === id)
    const identityChanges = new vscode.EventEmitter()
    const terminalIds = new Map()
    const identities = {
      onDidChange: identityChanges.event,
      id: (terminal: unknown) => terminalIds.get(terminal),
      find: (id: string) =>
        vscode.window.terminals.find(
          (terminal: unknown) => terminalIds.get(terminal) === id,
        ),
    }
    let placements = 0
    let placementReady: Promise<void> = Promise.resolve()
    const controller = new ChatController(
      identities,
      async (operation: () => Promise<unknown>) => {
        placements++
        await placementReady
        return operation()
      },
    )
    t.after(() => {
      controller.dispose()
      identityChanges.dispose()
    })
    vscode.window.terminals = []
    await until(() => !!peer)
    assert.equal(
      messages.length,
      0,
      'connecting needs no terminal announcements',
    )

    sendEvent(peer!, chatEvents.focus, { id: 'first', terminalId: 'a' })
    await delay(80)
    assert.equal(result('first'), undefined)
    assert.equal(placements, 0, 'restoration does not hold the placement queue')
    sendEvent(peer!, chatEvents.focus, { id: 'second', terminalId: 'b' })
    await until(() => !!result('first'))
    const superseded = result('first')
    assert.ok(superseded?.error)
    const a = terminal()
    terminalIds.set(a, 'a')
    vscode.window.terminals = [a]
    vscode.opened.fire(a)
    await delay(80)
    assert.equal(a.shows, 0, 'late restoration cannot steal focus')
    const b = terminal()
    vscode.window.terminals.push(b)
    controller.selectTerminal(b)
    assert.equal(controller.getActiveChatId(), undefined)
    terminalIds.set(b, 'b')
    identityChanges.fire()
    await until(() => !!result('second'))
    assert.deepEqual(result('second'), { id: 'second' })
    assert.equal(vscode.window.activeTerminal, b)

    sendEvent(peer!, chatEvents.snapshot, {
      chats: [
        { id: 'chat-b', terminalId: 'b', path: '/project', activity: 'idle' },
      ],
    })
    await until(() => controller.getSnapshot().chats.length === 1)
    assert.equal(controller.getActiveChatId(), 'chat-b')
    identityChanges.fire()
    assert.equal(
      controller.getActiveChatId(),
      'chat-b',
      'identity notifications do not adopt other terminals',
    )
    vscode.window.terminals = [a]
    terminalIds.delete(b)
    identityChanges.fire()
    assert.equal(controller.getActiveChatId(), undefined)

    // Cancellation must also be checked after waiting for a busy placement queue.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    placementReady = held
    const previousPlacements = placements
    sendEvent(peer!, chatEvents.focus, { id: 'held', terminalId: 'a' })
    await until(() => placements > previousPlacements)
    sendEvent(peer!, chatEvents.cancelFocus, 'held')
    await delay(30)
    release()
    await until(() => !!result('held'))
    assert.equal(a.shows, 0)

    sendEvent(peer!, chatEvents.focus, { id: 'timeout', terminalId: 'missing' })
    await delay(50)
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8100 })
    await delay(80)
    t.mock.timers.reset()
    await until(() => !!result('timeout'))
    const timedOut = result('timeout')
    assert.ok(timedOut?.error)

    sendEvent(peer!, chatEvents.focus, { id: 'disconnect', terminalId: 'c' })
    await delay(50)
    peer!.conn.close()
    await delay(50)
    const c = terminal()
    terminalIds.set(c, 'c')
    vscode.window.terminals.push(c)
    await delay(80)
    assert.equal(c.shows, 0, 'disconnected requests cannot focus later')
    await until(() => peer?.connected === true)
    sendEvent(peer!, chatEvents.focus, { id: 'reconnected', terminalId: 'c' })
    await until(() => !!result('reconnected'))
    assert.equal(c.shows, 1, 'reconnect can focus without announcing terminals')
    sendEvent(peer!, chatEvents.focus, { id: 'disposed', terminalId: 'd' })
    await delay(50)
    controller.dispose()
    const d = terminal()
    terminalIds.set(d, 'd')
    vscode.window.terminals.push(d)
    await delay(80)
    assert.equal(d.shows, 0)
  },
)

test(
  'bundled extension keeps control credentials out of identity scanner initialization and subprocesses',
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
            new URL('../fixtures/chat-vscode.mjs', import.meta.url),
          ),
        },
      },
      build: {
        target: 'node22',
        outDir: root,
        emptyOutDir: false,
        lib: {
          entry: {
            ...Object.fromEntries(
              ['chats', 'terminal-identities'].map((name) => [
                name,
                fileURLToPath(
                  new URL(
                    `../../extensions/ade-terminals/src/${name}.ts`,
                    import.meta.url,
                  ),
                ),
              ]),
            ),
            'chat-vscode': fileURLToPath(
              new URL('../fixtures/chat-vscode.mjs', import.meta.url),
            ),
          },
          formats: ['cjs'],
          fileName: (_format, name) => `${name}.cjs`,
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
      [fileURLToPath(new URL('./chat-credentials.cjs', import.meta.url)), root],
      { windowsHide: true, timeout: 15_000 },
    )
  },
)
