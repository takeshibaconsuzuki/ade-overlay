import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import {
  SharpImageEncoder,
  UrlClipboardImageReader,
} from '../src/desktop/clipboard/image-reader'
import { UrlClipboardResourceReader } from '../src/desktop/clipboard/resource-reader'
import { FetchHttpClient } from '../src/shared/http-client'

function reader() {
  return new UrlClipboardImageReader(
    new UrlClipboardResourceReader(new FetchHttpClient()),
    new SharpImageEncoder(),
  )
}

test('a GIF data URL is decoded to a static PNG without relying on a file extension or MIME type', async () => {
  const image = await reader().read(
    'data:application/octet-stream;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  )
  const metadata = await sharp(image).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 1)
  assert.equal(metadata.height, 1)
})

test('PNG, JPEG, and WebP bytes are detected and converted through the same reader', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const input = await sharp({
      create: { width: 2, height: 3, channels: 3, background: '#ffffff' },
    })
      .toFormat(format)
      .toBuffer()
    const output = await reader().read(
      `data:application/octet-stream;base64,${input.toString('base64')}`,
    )
    const metadata = await sharp(output).metadata()
    assert.equal(metadata.format, 'png')
    assert.equal(metadata.width, 2)
    assert.equal(metadata.height, 3)
  }
})

test('animated images produce only the first frame', async () => {
  const input = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), {
    raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
  })
    .gif()
    .toBuffer()
  const output = await reader().read(
    `data:image/gif;base64,${input.toString('base64')}`,
  )
  const { data, info } = await sharp(output)
    .raw()
    .toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 1)
  assert.equal(info.height, 1)
  assert.deepEqual([...data.subarray(0, 3)], [255, 0, 0])
})

test('JPEG orientation is applied to pixels before PNG metadata is stripped', async () => {
  const input = await sharp({
    create: { width: 2, height: 3, channels: 3, background: '#ffffff' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
  const output = await reader().read(
    `data:image/jpeg;base64,${input.toString('base64')}`,
  )
  const metadata = await sharp(output).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 3)
  assert.equal(metadata.height, 2)
  assert.equal(metadata.orientation, undefined)
})

test('invalid image bytes reject rather than producing an empty attachment', async () => {
  await assert.rejects(
    reader().read('data:text/plain,invalid'),
    /Clipboard image cannot be decoded/,
  )
})
