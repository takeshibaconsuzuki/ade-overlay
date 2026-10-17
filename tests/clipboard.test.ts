import assert from 'node:assert/strict'
import { test } from 'node:test'
import { convert } from 'html-to-text'
import type {
  ClipboardItem,
  ClipboardPart,
  ClipboardSource,
} from '../src/shared/clipboard'
import {
  HtmlClipboardNormalizer,
  type ClipboardImageReader,
} from '../src/desktop/clipboard/html'
import type { ClipboardImageEncoder } from '../src/desktop/clipboard/image-reader'
import { PngClipboardNormalizer } from '../src/desktop/clipboard/png'
import type {
  ClipboardResource,
  ClipboardResourceReader,
} from '../src/desktop/clipboard/resource-reader'
import { ClipboardService } from '../src/desktop/clipboard/service'
import { TextClipboardNormalizer } from '../src/desktop/clipboard/text'
import { UriListClipboardNormalizer } from '../src/desktop/clipboard/uri-list'
import { logger } from '../src/shared/logger'

class Item implements ClipboardItem {
  readonly types: string[]
  readonly reads: string[] = []
  constructor(private readonly data: Record<string, string | Uint8Array>) {
    this.types = Object.keys(data)
  }
  async read(type: string): Promise<Uint8Array> {
    this.reads.push(type)
    const value = this.data[type]
    return typeof value === 'string' ? new TextEncoder().encode(value) : value
  }
}

class ImageReader implements ClipboardImageReader {
  readonly sources: string[] = []
  async read(source: string): Promise<Uint8Array> {
    this.sources.push(source)
    if (source === 'missing') throw new Error('Missing image')
    return Buffer.from(source)
  }
}

function readable(parts: ClipboardPart[]) {
  return parts.map((part) => ({
    type: part.type,
    ...(part.type === 'text' ? {} : { name: part.name }),
    data: new TextDecoder().decode(part.data),
  }))
}

test('HTML normalization preserves interleaved text and image order without duplicating alt text or alternate representations', async () => {
  const imageReader = new ImageReader()
  const normalizer = new HtmlClipboardNormalizer(imageReader)
  const parts = await normalizer.normalize(
    new Item({
      'text/html':
        '<p>Before &amp; after</p><img src="first" alt="Do not duplicate"><p>Middle</p><img src="second"><p>End</p>',
      'text/plain': 'Do not append this alternate representation',
    }),
  )
  assert.deepEqual(
    parts.map((part) => part.type),
    ['text', 'image', 'text', 'image', 'text'],
  )
  assert.deepEqual(readable(parts), [
    { type: 'text', data: 'Before & after\n\n' },
    { type: 'image', name: 'image.png', data: 'first' },
    { type: 'text', data: '\n\nMiddle\n\n' },
    { type: 'image', name: 'image.png', data: 'second' },
    { type: 'text', data: '\n\nEnd' },
  ])
})

test('a single HTML image prefers the accompanying PNG bytes and never downloads its source', async () => {
  const imageReader = new ImageReader()
  const item = new Item({
    'text/html': '<img src="missing">',
    'image/png': new Uint8Array([0, 1, 255]),
  })
  assert.deepEqual(
    await new HtmlClipboardNormalizer(imageReader).normalize(item),
    [{ type: 'image', name: 'image.png', data: new Uint8Array([0, 1, 255]) }],
  )
  assert.deepEqual(imageReader.sources, [])
  assert.deepEqual(item.reads, ['text/html', 'image/png'])
})

test('images inside headings retain their markers while surrounding text uses default capitalization', async () => {
  const imageReader = new ImageReader()
  const parts = await new HtmlClipboardNormalizer(imageReader).normalize(
    new Item({
      'text/html':
        '<h1>Before<img src="first">Middle<img src="second">After</h1>',
    }),
  )
  assert.deepEqual(readable(parts), [
    { type: 'text', data: 'BEFORE' },
    { type: 'image', name: 'image.png', data: 'first' },
    { type: 'text', data: 'MIDDLE' },
    { type: 'image', name: 'image.png', data: 'second' },
    { type: 'text', data: 'AFTER' },
  ])
  assert.deepEqual(imageReader.sources, ['first', 'second'])
})

test('HTML text formatting follows html-to-text defaults without word wrapping', async () => {
  const normalizer = new HtmlClipboardNormalizer(new ImageReader())
  for (const html of [
    '<pre>  α &lt; β\n    next()</pre>',
    '<div style="white-space: pre"><div><span>  α &lt; β</span></div><div>    next()</div></div>',
    'before<span style="white-space: pre">  inline  </span>after',
    '<div hidden style="white-space: pre">secret</div><p>Visible</p>',
    '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>',
    '<h1>Title</h1><a href="https://example.com">Link</a>',
    'one<br>two',
    'Long text '.repeat(30),
  ]) {
    assert.deepEqual(
      readable(await normalizer.normalize(new Item({ 'text/html': html }))),
      [{ type: 'text', data: convert(html, { wordwrap: false }) }],
    )
  }
})

test('unresolved images reject the complete conversion', async () => {
  const normalizer = new HtmlClipboardNormalizer(new ImageReader())
  await assert.rejects(
    normalizer.normalize(
      new Item({ 'text/html': 'before<img src="missing">after' }),
    ),
    /Missing image/,
  )
  await assert.rejects(
    normalizer.normalize(new Item({ 'text/html': '<img>' })),
    /no source/,
  )
})

class Source implements ClipboardSource {
  constructor(readonly items: ClipboardItem[]) {}
  async read() {
    return this.items
  }
}

test('unsupported pastes log advertised formats without reading content and produce no parts', async (t) => {
  const item = new Item({
    'text/rtf': 'private text',
    'image/png': new Uint8Array([1]),
  })
  const warn = t.mock.method(logger, 'warn', () => {})
  const service = new ClipboardService(new Source([item]), [
    new HtmlClipboardNormalizer(new ImageReader()),
    new TextClipboardNormalizer(),
  ])
  assert.deepEqual(await service.readClipboard(), [])
  assert.deepEqual(warn.mock.calls[0].arguments, [
    { formats: [['text/rtf', 'image/png']], platform: process.platform },
    'Paste contains no supported clipboard representations',
  ])
  assert.deepEqual(item.reads, [])
})

test('supported multi-item copies retain item order; unsupported items and failed images are not silently dropped', async (t) => {
  const warn = t.mock.method(logger, 'warn', () => {})
  const source = new Source([
    new Item({ 'text/html': 'first' }),
    new Item({ 'text/html': 'second' }),
  ])
  const service = new ClipboardService(source, [
    new HtmlClipboardNormalizer(new ImageReader()),
    new TextClipboardNormalizer(),
  ])
  assert.deepEqual(readable((await service.readClipboard())!), [
    { type: 'text', data: 'first' },
    { type: 'text', data: 'second' },
  ])
  source.items.push(new Item({ 'text/rtf': 'unsupported' }))
  await assert.rejects(service.readClipboard(), /unsupported clipboard item/)
  assert.equal(warn.mock.callCount(), 1)
  source.items.splice(
    0,
    source.items.length,
    new Item({ 'text/html': '<img src="missing">' }),
  )
  await assert.rejects(service.readClipboard(), /Missing image/)
  assert.equal(warn.mock.callCount(), 2)
})

test('normalizer order prefers HTML when both representations exist and uses plain text when only that is available', async () => {
  const rich = new Item({
    'text/plain': 'alternate',
    'text/html': '<b>HTML</b>',
  })
  const plain = new Item({ 'text/plain': '  α\n\tplain text  ' })
  const service = new ClipboardService(new Source([rich, plain]), [
    new HtmlClipboardNormalizer(new ImageReader()),
    new TextClipboardNormalizer(),
  ])
  assert.deepEqual(readable(await service.readClipboard()), [
    { type: 'text', data: 'HTML' },
    { type: 'text', data: '  α\n\tplain text  ' },
  ])
  assert.deepEqual(rich.reads, ['text/html'])
  assert.deepEqual(plain.reads, ['text/plain'])
})

test('a selected HTML normalizer failing does not fall through to plain text', async (t) => {
  t.mock.method(logger, 'warn', () => {})
  const item = new Item({
    'text/html': '<img src="missing">',
    'text/plain': 'alternate',
  })
  const service = new ClipboardService(new Source([item]), [
    new HtmlClipboardNormalizer(new ImageReader()),
    new TextClipboardNormalizer(),
  ])
  await assert.rejects(service.readClipboard(), /Missing image/)
  assert.deepEqual(item.reads, ['text/html'])
})

test('native image Buffers become plain byte arrays suitable for RPC', async () => {
  const service = new ClipboardService(
    new Source([new Item({ 'text/html': '<img src="image">' })]),
    [new HtmlClipboardNormalizer(new ImageReader())],
  )
  const parts = (await service.readClipboard())!
  assert.equal(parts[0].data.constructor, Uint8Array)
  assert.deepEqual(parts[0].data, new Uint8Array(Buffer.from('image')))
})

class ResourceReader implements ClipboardResourceReader {
  readonly sources: string[] = []
  constructor(
    private readonly resources: Record<
      string,
      { name: string; mediaType?: string; data: string }
    >,
  ) {}
  async read(source: string): Promise<ClipboardResource> {
    this.sources.push(source)
    const resource = this.resources[source]
    if (!resource) throw new Error(`Missing resource ${source}`)
    return {
      name: resource.name,
      mediaType: resource.mediaType,
      data: new TextEncoder().encode(resource.data),
    }
  }
}

class ImageEncoder implements ClipboardImageEncoder {
  async encode(data: Uint8Array): Promise<Uint8Array> {
    return new TextEncoder().encode(`png:${new TextDecoder().decode(data)}`)
  }
}

test('a bare PNG representation becomes one named image part', async () => {
  const item = new Item({
    'image/png': new Uint8Array([137, 80]),
    'text/plain': 'alternate',
  })
  assert.deepEqual(await new PngClipboardNormalizer().normalize(item), [
    { type: 'image', name: 'image.png', data: new Uint8Array([137, 80]) },
  ])
  assert.deepEqual(item.reads, ['image/png'])
})

test('URI lists resolve each entry in order, attaching images and uploading other files by name', async () => {
  const reader = new ResourceReader({
    'file:///home/user/photo.jpg': {
      name: 'photo.jpg',
      mediaType: 'image/jpeg',
      data: 'jpeg bytes',
    },
    'file:///home/user/notes.txt': {
      name: 'notes.txt',
      mediaType: 'text/plain',
      data: 'notes',
    },
    'https://example.com/download': { name: 'download', data: 'blob' },
  })
  const parts = await new UriListClipboardNormalizer(
    reader,
    new ImageEncoder(),
  ).normalize(
    new Item({
      'text/uri-list':
        '# copied files\r\nfile:///home/user/photo.jpg\r\n\r\nfile:///home/user/notes.txt\nhttps://example.com/download\n',
      'text/plain': '/home/user/photo.jpg\n/home/user/notes.txt',
    }),
  )
  assert.deepEqual(parts, [
    {
      type: 'image',
      name: 'photo.png',
      data: new TextEncoder().encode('png:jpeg bytes'),
    },
    {
      type: 'file',
      name: 'notes.txt',
      data: new TextEncoder().encode('notes'),
    },
    { type: 'file', name: 'download', data: new TextEncoder().encode('blob') },
  ])
  assert.deepEqual(reader.sources, [
    'file:///home/user/photo.jpg',
    'file:///home/user/notes.txt',
    'https://example.com/download',
  ])
})

test('URI lists reject when empty or when any entry cannot be resolved', async () => {
  const normalizer = new UriListClipboardNormalizer(
    new ResourceReader({
      'file:///a': { name: 'a', data: 'a' },
    }),
    new ImageEncoder(),
  )
  await assert.rejects(
    normalizer.normalize(new Item({ 'text/uri-list': '# only a comment\n' })),
    /URI list is empty/,
  )
  await assert.rejects(
    normalizer.normalize(
      new Item({ 'text/uri-list': 'file:///a\nfile:///missing' }),
    ),
    /Missing resource file:\/\/\/missing/,
  )
})

test('normalizer order prefers HTML, then URI lists, then PNG, before plain text', async () => {
  const service = new ClipboardService(
    new Source([
      new Item({
        'text/uri-list': 'file:///a',
        'image/png': new Uint8Array([1]),
        'text/plain': '/a',
      }),
      new Item({ 'image/png': new Uint8Array([2]), 'text/plain': 'alt' }),
      new Item({ 'text/html': '<b>rich</b>', 'text/uri-list': 'file:///a' }),
    ]),
    [
      new HtmlClipboardNormalizer(new ImageReader()),
      new UriListClipboardNormalizer(
        new ResourceReader({ 'file:///a': { name: 'a', data: 'file a' } }),
        new ImageEncoder(),
      ),
      new PngClipboardNormalizer(),
      new TextClipboardNormalizer(),
    ],
  )
  assert.deepEqual(await service.readClipboard(), [
    { type: 'file', name: 'a', data: new TextEncoder().encode('file a') },
    { type: 'image', name: 'image.png', data: new Uint8Array([2]) },
    { type: 'text', data: new TextEncoder().encode('rich') },
  ])
})
