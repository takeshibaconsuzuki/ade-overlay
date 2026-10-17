import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { UrlClipboardResourceReader } from '../src/desktop/clipboard/resource-reader'
import { FetchHttpClient, type HttpClient } from '../src/shared/http-client'

class FakeHttpClient implements HttpClient {
  readonly requests: string[] = []
  constructor(
    private readonly responses: Record<
      string,
      { body: string; type?: string; status?: number }
    >,
  ) {}
  async fetch(url: string): Promise<Response> {
    this.requests.push(url)
    const response = this.responses[url]
    if (!response) throw new Error('Network failure')
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: response.type ? { 'content-type': response.type } : {},
    })
  }
}

test('file URLs read local bytes with the file name and extension-derived media type', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-clipboard-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'My Notes.MD')
  await writeFile(path, 'hello')
  const reader = new UrlClipboardResourceReader(new FetchHttpClient())
  const resource = await reader.read(pathToFileURL(path).href)
  assert.equal(resource.name, 'My Notes.MD')
  assert.equal(resource.mediaType, 'text/markdown')
  assert.deepEqual(resource.data, Buffer.from('hello'))
  const unknown = join(directory, 'archive')
  await writeFile(unknown, 'x')
  assert.equal(
    (await reader.read(pathToFileURL(unknown).href)).mediaType,
    undefined,
  )
  await assert.rejects(
    reader.read(pathToFileURL(join(directory, 'missing')).href),
    /Unable to read clipboard file/,
  )
  await assert.rejects(
    reader.read(pathToFileURL(directory).href),
    /Unable to read clipboard file/,
  )
})

test('HTTP resources take their name from the URL path and prefer the extension over the declared type', async () => {
  const http = new FakeHttpClient({
    'https://example.com/files/Report%20Q3.pdf?download=1': {
      body: 'pdf',
      type: 'application/octet-stream',
    },
    'https://example.com/image': { body: 'img', type: 'image/webp; q=0.9' },
    'https://example.com/': { body: 'home', type: 'text/html' },
    'https://example.com/missing': { body: '', status: 404 },
  })
  const reader = new UrlClipboardResourceReader(http)
  const report = await reader.read(
    'https://example.com/files/Report%20Q3.pdf?download=1',
  )
  assert.equal(report.name, 'Report Q3.pdf')
  assert.equal(report.mediaType, 'application/pdf')
  const image = await reader.read('//example.com/image')
  assert.equal(image.name, 'image')
  assert.equal(image.mediaType, 'image/webp')
  const home = await reader.read('https://example.com/')
  assert.equal(home.name, 'clipboard.html')
  assert.equal(home.mediaType, 'text/html')
  await assert.rejects(
    reader.read('https://example.com/missing'),
    /Unable to download clipboard resource/,
  )
  await assert.rejects(
    reader.read('https://example.com/offline'),
    /Unable to download clipboard resource/,
  )
  await assert.rejects(reader.read('not a url'), /not an absolute URL/)
  await assert.rejects(
    reader.read('ftp://example.com/a'),
    /scheme is unsupported/,
  )
})

test('unnamed resources share one name with an extension from their media type', async () => {
  const reader = new UrlClipboardResourceReader(new FetchHttpClient())
  const svg = await reader.read('data:image/svg+xml;base64,PHN2Zy8+')
  assert.equal(svg.name, 'clipboard.svg')
  assert.equal(svg.mediaType, 'image/svg+xml')
  assert.equal(new TextDecoder().decode(svg.data), '<svg/>')
  const plain = await reader.read('data:,hello')
  assert.equal(plain.name, 'clipboard.txt')
  assert.equal(plain.mediaType, 'text/plain')
  const binary = await reader.read('data:application/x-unknown-thing,hello')
  assert.equal(binary.name, 'clipboard')
  assert.equal(binary.mediaType, 'application/x-unknown-thing')
})
