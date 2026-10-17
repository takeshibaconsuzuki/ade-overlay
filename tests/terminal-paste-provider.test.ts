import assert from 'node:assert/strict'
import { chmod, readFile, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ClaudeTerminalProvider } from '../vscode-extension/src/providers/claude'
import { CodexTerminalProvider } from '../vscode-extension/src/providers/codex'
import {
  TemporaryChatFileWriter,
  type ChatFileWriter,
} from '../vscode-extension/src/chat-file-writer'

class Writer implements ChatFileWriter {
  data: Uint8Array[] = []
  names: string[] = []
  async write(name: string, data: Uint8Array): Promise<string> {
    this.data.push(data)
    this.names.push(name)
    return `/remote path/${this.data.length}/${name}`
  }
}

test('Codex converts mixed content to separate ordered text and image-path paste events', async () => {
  const imageFileWriter = new Writer()
  const provider = new CodexTerminalProvider()
  const pastes = await provider.convertClipboard(
    [
      { type: 'text', data: new TextEncoder().encode('α\n  before') },
      { type: 'image', name: 'shot.png', data: new Uint8Array([1]) },
      { type: 'text', data: new TextEncoder().encode('middle') },
      { type: 'image', name: 'image.png', data: new Uint8Array([2]) },
      { type: 'text', data: new TextEncoder().encode('after') },
    ],
    imageFileWriter,
  )
  assert.deepEqual(pastes, [
    { text: 'α\n  before' },
    {
      text: '"/remote path/1/shot.png"',
      beforeDelay: 200,
      afterDelay: 200,
    },
    { text: 'middle' },
    {
      text: '"/remote path/2/image.png"',
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
  const image = {
    type: 'image' as const,
    name: 'image.png',
    data: new Uint8Array([1]),
  }
  assert.deepEqual(await provider.convertClipboard([image], new Writer()), [
    {
      text: '"/remote path/1/image.png"',
      beforeDelay: 200,
      afterDelay: 200,
    },
  ])
  assert.deepEqual(
    await provider.convertClipboard([image, image], new Writer()),
    [
      {
        text: '"/remote path/1/image.png"',
        beforeDelay: 200,
        afterDelay: 200,
      },
      {
        text: '"/remote path/2/image.png"',
        beforeDelay: 200,
        afterDelay: 200,
      },
    ],
  )
})

test('Claude Code receives text and escaped image paths as separate ordered paste events', async () => {
  class WindowsWriter extends Writer {
    async write(name: string, data: Uint8Array): Promise<string> {
      await super.write(name, data)
      return `C:\\Users\\A User\\${this.data.length}\\${name}`
    }
  }
  const imageFileWriter = new WindowsWriter()
  const image = {
    type: 'image' as const,
    name: 'image.png',
    data: new Uint8Array([1]),
  }
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
        text: 'C:\\\\Users\\\\A User\\\\1\\\\image.png',
        beforeDelay: 200,
        afterDelay: 200,
      },
      {
        text: 'C:\\\\Users\\\\A User\\\\2\\\\image.png',
        beforeDelay: 200,
        afterDelay: 200,
      },
      { text: 'after' },
    ],
  )
  assert.equal(imageFileWriter.data.length, 2)
  assert.deepEqual(imageFileWriter.names, ['image.png', 'image.png'])
  assert.deepEqual(
    await new ClaudeTerminalProvider().convertClipboard([image], new Writer()),
    [{ text: '/remote path/1/image.png', beforeDelay: 200, afterDelay: 200 }],
  )
})

test('temporary files survive host recreation for their terminal and are removed when it closes', async (t) => {
  const id = randomUUID()
  const first = new TemporaryChatFileWriter(id)
  const restored = new TemporaryChatFileWriter(id)
  t.after(() => restored.dispose())
  const data = new Uint8Array([0, 255, 3])
  const path = await first.write('image.png', data)
  assert.deepEqual(await readFile(path), Buffer.from(data))
  assert.equal(await restored.write('image.png', data), path)
  await restored.dispose()
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  await assert.rejects(restored.write('image.png', data), /closed during paste/)
})

test(
  'files and their directories are private on POSIX, including when the writer is restored',
  { skip: process.platform === 'win32' },
  async (t) => {
    const id = randomUUID()
    const writer = new TemporaryChatFileWriter(id)
    t.after(() => writer.dispose())
    const path = await writer.write('image.png', new Uint8Array([1]))
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700)
    assert.equal((await stat(dirname(dirname(path)))).mode & 0o777, 0o700)
    await chmod(dirname(path), 0o755)
    await chmod(dirname(dirname(path)), 0o755)
    await new TemporaryChatFileWriter(id).write(
      'image.png',
      new Uint8Array([1]),
    )
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700)
    assert.equal((await stat(dirname(dirname(path)))).mode & 0o777, 0o700)
  },
)

test('both providers upload non-image files under their names and paste self-delimiting quoted references', async () => {
  const file = {
    type: 'file' as const,
    name: 'report final.pdf',
    data: new Uint8Array([1, 2]),
  }
  const other = { type: 'file' as const, name: 'b.txt', data: new Uint8Array() }
  for (const [provider, first, second] of [
    [
      new ClaudeTerminalProvider(),
      '@"/remote path/1/report final.pdf" ',
      '@"/remote path/2/b.txt" ',
    ],
    [
      new CodexTerminalProvider(),
      '"/remote path/1/report final.pdf" ',
      '"/remote path/2/b.txt" ',
    ],
  ] as const) {
    const writer = new Writer()
    assert.deepEqual(
      await provider.convertClipboard(
        [{ type: 'text', data: new TextEncoder().encode('see ') }, file, other],
        writer,
      ),
      [{ text: 'see ' }, { text: first }, { text: second }],
    )
    assert.deepEqual(writer.names, ['report final.pdf', 'b.txt'])
    assert.deepEqual(writer.data, [new Uint8Array([1, 2]), new Uint8Array()])
  }
})

test('file names are confined to the paste directory and keep their content apart', async (t) => {
  const writer = new TemporaryChatFileWriter(randomUUID())
  t.after(() => writer.dispose())
  const escaped = await writer.write('../../etc/passwd', new Uint8Array([1]))
  assert.equal(basename(escaped), '....etcpasswd')
  assert.equal(basename(dirname(dirname(dirname(escaped)))), 'chat-paste')
  assert.equal(basename(await writer.write('', new Uint8Array([1]))), 'file')
  const first = await writer.write('notes.txt', new Uint8Array([1]))
  const second = await writer.write('notes.txt', new Uint8Array([2]))
  assert.notEqual(first, second)
  assert.equal(basename(first), 'notes.txt')
  assert.deepEqual(await readFile(second), Buffer.from([2]))
  assert.equal(
    dirname(await writer.write('other.txt', new Uint8Array([1]))),
    dirname(first),
  )
})
