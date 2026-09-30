import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { materializePaste } from '../../src/server/chats/chat-paste.ts'
import { chatProviders } from '../../src/server/chats/chat-providers.ts'
import { ChatService } from '../../src/server/chats/chat-service.ts'
import { createCompanionTransport } from '../../src/server/companion-transport.ts'
import type { WorktreeStore } from '../../src/server/worktrees/worktree-store.ts'
import { silentLogger } from '../../src/server/logging.ts'
import { callRpc, handleRpc } from '../../src/shared/rpc.ts'
import { companionRequests } from '../../src/shared/companion.ts'
import { chatRequests } from '../../src/shared/chats.ts'
import type { PasteTarget } from '../../src/shared/paste-schema.ts'
import type { PastePart } from '../../src/shared/paste.ts'
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

test('dropped files keep safe names; supported images become images', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-paste-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pdf = Buffer.from('%PDF-1.4\n')
  const parts = await materializePaste(
    [
      { type: 'file', name: 'report one.pdf', data: pdf },
      { type: 'file', name: '../notes.txt', data: Buffer.from('notes') },
      { type: 'file', name: 'screenshot.png', data: png },
      // Valid UTF-16 lengths can exceed file-system byte limits.
      {
        type: 'file',
        name: '資'.repeat(82) + '👍🏽'.repeat(3) + '.txt',
        data: pdf,
      },
    ],
    root,
  )
  const long = basename(parts.pop()!.data)
  assert.ok(Buffer.byteLength(long) <= 200, long)
  assert.match(long, /^資+(👍🏽)*\.txt$/u)
  assert.deepEqual(
    parts.map((part) => [part.type, basename(part.data)]),
    [
      ['file', 'report one.pdf'],
      ['file', '_notes.txt'],
      ['image', basename(parts[2].data)],
    ],
  )
  assert.deepEqual(await readFile(parts[0].data), pdf)
  assert.equal(dirname(dirname(parts[1].data)), join(root, 'paste-files'))
  assert.equal(dirname(parts[2].data), join(root, 'paste-images'))
  for (const provider of chatProviders)
    assert.deepEqual(
      frames(provider.preparePaste(parts)),
      provider.id === 'codex'
        ? [
            `"${parts[0].data}" `,
            `${parts[1].data} `,
            pathToFileURL(parts[2].data).href,
          ]
        : [
            parts
              .map(
                (part) =>
                  '\n@' +
                  JSON.stringify(part.data.replaceAll('\\', '/')) +
                  '\n',
              )
              .join(''),
          ],
    )
})

test(
  'companion owns scoped reservations and pastes before any activity hook, preserving target and delivery order',
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ade-paste-service-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const chats = new ChatService(undefined, undefined, root)
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
    let target: PasteTarget | null = {
      terminalId: 'reserved',
      provider: 'codex',
    }
    handleRpc(extension.socket, chatRequests.pasteTarget, () => target)
    const deliveries: { terminalId: string; text: string; provider: string }[] =
      []
    handleRpc(extension.socket, chatRequests.paste, (payload) => {
      deliveries.push(payload)
      return null
    })
    assert.deepEqual(
      chats.store.list().chats,
      [],
      'no hook has registered a chat',
    )
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
    const documentId = randomUUID()
    const reserve = async () => {
      const id = await callRpc(peer.socket, companionRequests.reservePaste, {
        editorId,
        documentId,
      })
      assert.ok(id)
      return id
    }
    const paste = (reservationId: string, items: PastePart[]) =>
      callRpc(peer.socket, companionRequests.paste, {
        editorId,
        documentId,
        reservationId,
        items,
      })
    const id = await reserve()
    target = { terminalId: 'different-focus', provider: 'claude' }
    const largeImage = Buffer.concat([png, Buffer.alloc(24 * 1024)])
    assert.equal(
      await paste(id, [
        { type: 'text', data: 'before\n  indent' },
        { type: 'image', data: largeImage },
        { type: 'text', data: 'after' },
      ]),
      null,
    )
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].terminalId, 'reserved')
    assert.equal(
      deliveries[0].provider,
      'codex',
      'reserved provider survives focus changes too',
    )
    const parts = frames(deliveries[0].text)
    assert.deepEqual([parts[0], parts[2]], ['before\n  indent', 'after'])
    assert.deepEqual(await readFile(fileURLToPath(parts[1])), largeImage)
    await assert.rejects(
      paste(id, []),
      /invalid or expired/,
      'one-use reservation',
    )
    await assert.rejects(paste(randomUUID(), []), /invalid or expired/)
    const scoped = await reserve()
    const other = await socketPeer(
      t,
      `ws://127.0.0.1:${address.port}/companion`,
    )
    for (const [socket, overrides] of [
      [other.socket, {}],
      [peer.socket, { editorId: 'b'.repeat(64) }],
      [peer.socket, { documentId: randomUUID() }],
    ] as const) {
      await assert.rejects(
        callRpc(socket, companionRequests.paste, {
          editorId,
          documentId,
          reservationId: scoped,
          items: [],
          ...overrides,
        }),
        /invalid or expired/,
      )
    }
    assert.equal(
      await paste(scoped, [{ type: 'text', data: 'text before first prompt' }]),
      null,
    )
    assert.equal(deliveries[1].provider, 'claude')
    assert.deepEqual(frames(deliveries[1].text), ['text before first prompt'])
    // Dropped files travel through the same binary transport and reservation.
    assert.equal(
      await paste(await reserve(), [
        { type: 'file', name: 'drop.txt', data: Buffer.from('dropped') },
      ]),
      null,
    )
    const [dropped] = frames(deliveries[2].text)
    assert.equal(deliveries[2].terminalId, 'different-focus')
    assert.match(dropped, /^\n@".*[\\/]drop\.txt"\n$/)
    assert.equal(
      await readFile(JSON.parse(dropped.slice(2, -1)), 'utf8'),
      'dropped',
    )
    deliveries.pop()
    assert.deepEqual(
      chats.store.list().chats,
      [],
      'paste does not synthesize activity records',
    )

    target = null
    assert.equal(
      await callRpc(peer.socket, companionRequests.reservePaste, {
        editorId,
        documentId,
      }),
      null,
    )
    target = { terminalId: 'reserved', provider: 'codex' }
    const expired = await reserve()
    const now = Date.now()
    const clock = t.mock.method(Date, 'now', () => now + 30_001)
    await assert.rejects(paste(expired, []), /invalid or expired/)
    clock.mock.restore()

    await assert.rejects(
      paste(await reserve(), [
        { type: 'text', data: 'do not partially paste' },
        { type: 'image', data: new Uint8Array([0]) },
      ]),
    )
    assert.equal(deliveries.length, 2)
    const first = await reserve()
    const second = await reserve()
    const orderedFirst = paste(first, [
      { type: 'image', data: `http://127.0.0.1:${address.port}/image` },
    ])
    await downloading
    const orderedSecond = paste(second, [
      { type: 'text', data: 'second paste' },
    ])
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(deliveries.length, 2)
    releaseImage()
    await Promise.all([orderedFirst, orderedSecond])
    assert.equal(deliveries.length, 4)
    assert.deepEqual(frames(deliveries[3].text), ['second paste'])

    downloading = new Promise<void>((resolve) => {
      imageStarted = resolve
    })
    const pending = paste(await reserve(), [
      { type: 'image', data: `http://127.0.0.1:${address.port}/image` },
    ])
    const rejected = assert.rejects(pending, /connection changed/)
    await downloading
    chats.releaseEditor(editorId)
    releaseImage()
    await rejected
    assert.equal(
      deliveries.length,
      4,
      'closure never redirects a prepared paste',
    )
  },
)
