import assert from 'node:assert/strict'
import { chmod, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ClaudeTerminalProvider } from '../vscode-extension/src/providers/claude'
import { CodexTerminalProvider } from '../vscode-extension/src/providers/codex'
import {
  TemporaryImageFileWriter,
  type ImageFileWriter,
} from '../vscode-extension/src/image-file-writer'

class Writer implements ImageFileWriter {
  data: Uint8Array[] = []
  async write(data: Uint8Array): Promise<string> {
    this.data.push(data)
    return `/remote path/image-${this.data.length}.png`
  }
}

test('Codex converts mixed content to separate ordered text and image-path paste events', async () => {
  const imageFileWriter = new Writer()
  const provider = new CodexTerminalProvider()
  const pastes = await provider.convertClipboard(
    [
      { type: 'text', data: new TextEncoder().encode('α\n  before') },
      { type: 'image', data: new Uint8Array([1]) },
      { type: 'text', data: new TextEncoder().encode('middle') },
      { type: 'image', data: new Uint8Array([2]) },
      { type: 'text', data: new TextEncoder().encode('after') },
    ],
    imageFileWriter,
  )
  assert.deepEqual(pastes, [
    { text: 'α\n  before' },
    {
      text: '"/remote path/image-1.png"',
      beforeDelay: 200,
      afterDelay: 200,
    },
    { text: 'middle' },
    {
      text: '"/remote path/image-2.png"',
      beforeDelay: 200,
      afterDelay: 200,
    },
    { text: 'after' },
  ])
  assert.deepEqual(imageFileWriter.data, [
    new Uint8Array([1]),
    new Uint8Array([2]),
  ])
})

test('Codex keeps single and consecutive image attachments in separate paste events', async () => {
  const provider = new CodexTerminalProvider()
  const image = { type: 'image' as const, data: new Uint8Array([1]) }
  assert.deepEqual(await provider.convertClipboard([image], new Writer()), [
    {
      text: '"/remote path/image-1.png"',
      beforeDelay: 200,
      afterDelay: 200,
    },
  ])
  assert.deepEqual(
    await provider.convertClipboard([image, image], new Writer()),
    [
      {
        text: '"/remote path/image-1.png"',
        beforeDelay: 200,
        afterDelay: 200,
      },
      {
        text: '"/remote path/image-2.png"',
        beforeDelay: 200,
        afterDelay: 200,
      },
    ],
  )
})

test('Claude Code receives text and escaped image paths as separate ordered paste events', async () => {
  class WindowsWriter extends Writer {
    async write(data: Uint8Array): Promise<string> {
      await super.write(data)
      return `C:\\Users\\A User\\image-${this.data.length}.png`
    }
  }
  const imageFileWriter = new WindowsWriter()
  const image = { type: 'image' as const, data: new Uint8Array([1]) }
  assert.deepEqual(
    await new ClaudeTerminalProvider().convertClipboard(
      [
        { type: 'text', data: new TextEncoder().encode('α\n  before') },
        image,
        image,
        { type: 'text', data: new TextEncoder().encode('after') },
      ],
      imageFileWriter,
    ),
    [
      { text: 'α\n  before' },
      {
        text: 'C:\\\\Users\\\\A User\\\\image-1.png',
        beforeDelay: 200,
        afterDelay: 200,
      },
      {
        text: 'C:\\\\Users\\\\A User\\\\image-2.png',
        beforeDelay: 200,
        afterDelay: 200,
      },
      { text: 'after' },
    ],
  )
  assert.equal(imageFileWriter.data.length, 2)
  assert.deepEqual(
    await new ClaudeTerminalProvider().convertClipboard([image], new Writer()),
    [{ text: '/remote path/image-1.png', beforeDelay: 200, afterDelay: 200 }],
  )
})

test('temporary images survive host recreation for their terminal and are removed when it closes', async (t) => {
  const id = randomUUID()
  const first = new TemporaryImageFileWriter(id)
  const restored = new TemporaryImageFileWriter(id)
  t.after(() => restored.dispose())
  const data = new Uint8Array([0, 255, 3])
  const path = await first.write(data)
  assert.deepEqual(await readFile(path), Buffer.from(data))
  assert.equal(await restored.write(data), path)
  await restored.dispose()
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  await assert.rejects(restored.write(data), /closed during paste/)
})

test(
  'image files and their directory are private on POSIX, including when the writer is restored',
  { skip: process.platform === 'win32' },
  async (t) => {
    const id = randomUUID()
    const writer = new TemporaryImageFileWriter(id)
    t.after(() => writer.dispose())
    const path = await writer.write(new Uint8Array([1]))
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700)
    await chmod(dirname(path), 0o755)
    await new TemporaryImageFileWriter(id).write(new Uint8Array([2]))
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700)
  },
)
