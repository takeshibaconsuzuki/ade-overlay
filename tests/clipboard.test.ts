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
import { ClipboardService } from '../src/desktop/clipboard/service'
import { TextClipboardNormalizer } from '../src/desktop/clipboard/text'
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
    { type: 'image', data: 'first' },
    { type: 'text', data: '\n\nMiddle\n\n' },
    { type: 'image', data: 'second' },
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
    [{ type: 'image', data: new Uint8Array([0, 1, 255]) }],
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
    { type: 'image', data: 'first' },
    { type: 'text', data: 'MIDDLE' },
    { type: 'image', data: 'second' },
    { type: 'text', data: 'AFTER' },
  ])
  assert.deepEqual(imageReader.sources, ['first', 'second'])
})

test('HTML text formatting follows html-to-text defaults', async () => {
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
      [{ type: 'text', data: convert(html) }],
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
