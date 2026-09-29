import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { materializePaste } from '../../src/server/chats/chat-paste.ts'
import { chatProviders } from '../../src/server/chats/chat-providers.ts'
import { ChatService } from '../../src/server/chats/chat-service.ts'
import { ChatStore } from '../../src/server/chats/chat-store.ts'
import { createCompanionTransport } from '../../src/server/companion-transport.ts'
import type { WorktreeStore } from '../../src/server/worktrees/worktree-store.ts'
import { silentLogger } from '../../src/server/logging.ts'
import { callRpc, handleRpc } from '../../src/shared/rpc.ts'
import { companionRequests } from '../../src/shared/companion.ts'
import { chatRequests } from '../../src/shared/chats.ts'
import { socketPeer } from '../helpers/socket.ts'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=',
  'base64',
)
const frames = (text: string) =>
  text
    .split('\x1b[200~')
    .slice(1)
    .map((frame) => {
      assert.ok(frame.endsWith('\x1b[201~'))
      return frame.slice(0, -6)
    })

test('providers prepare ordered bracketed text and image paths without Enter', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-paste-images-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parts = await materializePaste(
    [
      { type: 'text', data: '  first\n  second' },
      { type: 'image', data: png },
      { type: 'text', data: 'middle' },
      { type: 'image', data: png },
      { type: 'text', data: 'last\n' },
    ],
    join(root, 'images with spaces'),
  )
  assert.ok(isAbsolute(parts[1].data))
  assert.deepEqual(await readFile(parts[1].data), png)
  assert.equal(
    parts[1].data,
    parts[3].data,
    'duplicate images share a stable file',
  )
  for (const provider of chatProviders) {
    assert.deepEqual(
      frames(provider.preparePaste(parts)),
      provider.id === 'codex'
        ? parts.map((part) =>
            part.type === 'text' ? part.data : pathToFileURL(part.data).href,
          )
        : [
            parts
              .map((part) =>
                part.type === 'text'
                  ? part.data
                  : '\n@' +
                    JSON.stringify(part.data.replaceAll('\\', '/')) +
                    '\n',
              )
              .join(''),
          ],
    )
    assert.deepEqual(
      frames(
        provider.preparePaste([
          { type: 'text', data: 'code\x1b[201~\x03\0\n\tend' },
        ]),
      ),
      ['code[201~\n\tend'],
    )
  }
  await assert.rejects(
    materializePaste(
      [{ type: 'image', data: new Uint8Array([1, 2, 3]) }],
      root,
    ),
  )
  await assert.rejects(
    materializePaste([{ type: 'image', data: 'file:///secret.png' }], root),
    /HTTP/,
  )
})

test(
  'companion accepts binary pastes, prepares provider payloads and delivers only to the reserved editor',
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ade-paste-service-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const process = {
      pid: 20,
      parentPid: 1,
      startedAt: 'provider-start',
      name: 'codex',
      command: 'codex',
    }
    const processes = new Map([[20, process]])
    const store = new ChatStore(async () => processes)
    const chats = new ChatService(undefined, store, root)
    await chats.listen()
    t.after(() => chats.close())
    const worktree = { project: root, path: root }
    const editorId = 'a'.repeat(64)
    const registration = chats.registerEditor(editorId, worktree)
    const extensionUrl = new URL(
      '/extension',
      registration.activityEnvironment.ADE_CHAT_ENDPOINT,
    )
    extensionUrl.searchParams.set('activation', randomUUID())
    extensionUrl.searchParams.set('startedAt', String(Date.now()))
    const extension = await socketPeer(
      t,
      extensionUrl,
      registration.controlToken,
    )
    const deliveries: { terminalId: string; text: string }[] = []
    handleRpc(extension.socket, chatRequests.paste, (payload) => {
      deliveries.push(payload)
      return null
    })
    await store.activity(editorId, worktree, {
      provider: 'codex',
      sessionId: 'session',
      terminalId: 'reserved',
      process,
      observedAt: 1,
      activity: 'idle',
    })
    let releaseImage!: () => void
    let imageStarted!: () => void
    let downloading = new Promise<void>((resolve) => {
      imageStarted = resolve
    })
    const http = createServer((request, response) => {
      if (request.url === '/image') {
        imageStarted()
        releaseImage = () => {
          response.writeHead(200, { 'Content-Type': 'image/png' })
          response.end(png)
        }
      } else response.writeHead(404).end()
    })
    const transport = createCompanionTransport({
      worktrees: new EventEmitter() as WorktreeStore,
      chats,
      logger: silentLogger,
    })
    http.on('upgrade', (request, socket, head) =>
      transport.handleUpgrade(request, socket, head),
    )
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    t.after(async () => {
      await transport.close()
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    })
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    const peer = await socketPeer(t, `ws://127.0.0.1:${address.port}/companion`)
    const largeImage = Buffer.concat([png, Buffer.alloc(24 * 1024)])
    assert.equal(
      await callRpc(peer.socket, companionRequests.paste, {
        editorId,
        terminalId: 'reserved',
        items: [
          { type: 'text', data: 'before\n  indent' },
          { type: 'image', data: largeImage },
          { type: 'text', data: 'after' },
        ],
      }),
      null,
    )
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].terminalId, 'reserved')
    const parts = frames(deliveries[0].text)
    assert.deepEqual([parts[0], parts[2]], ['before\n  indent', 'after'])
    assert.deepEqual(await readFile(fileURLToPath(parts[1])), largeImage)
    await assert.rejects(
      callRpc(peer.socket, companionRequests.paste, {
        editorId: 'b'.repeat(64),
        terminalId: 'reserved',
        items: [],
      }),
      /disconnected/,
    )
    await assert.rejects(
      callRpc(peer.socket, companionRequests.paste, {
        editorId,
        terminalId: 'other',
        items: [],
      }),
      /not running/,
    )
    await assert.rejects(
      callRpc(peer.socket, companionRequests.paste, {
        editorId,
        terminalId: 'reserved',
        items: [
          { type: 'text', data: 'do not partially paste' },
          { type: 'image', data: new Uint8Array([0]) },
        ],
      }),
    )
    assert.equal(deliveries.length, 1)

    const orderedFirst = callRpc(peer.socket, companionRequests.paste, {
      editorId,
      terminalId: 'reserved',
      items: [
        { type: 'image', data: `http://127.0.0.1:${address.port}/image` },
      ],
    })
    await downloading
    const orderedSecond = callRpc(peer.socket, companionRequests.paste, {
      editorId,
      terminalId: 'reserved',
      items: [{ type: 'text', data: 'second paste' }],
    })
    // The second preparation must finish independently, but cannot deliver yet.
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(deliveries.length, 1)
    releaseImage()
    await Promise.all([orderedFirst, orderedSecond])
    assert.equal(deliveries.length, 3)
    assert.deepEqual(frames(deliveries[2].text), ['second paste'])
    downloading = new Promise<void>((resolve) => {
      imageStarted = resolve
    })
    const pending = callRpc(peer.socket, companionRequests.paste, {
      editorId,
      terminalId: 'reserved',
      items: [
        { type: 'image', data: `http://127.0.0.1:${address.port}/image` },
      ],
    })
    const rejected = assert.rejects(pending, /chat changed/)
    await downloading
    chats.releaseEditor(editorId)
    releaseImage()
    await rejected
    assert.equal(
      deliveries.length,
      3,
      'reconnect/closure never redirects a prepared paste',
    )
  },
)
