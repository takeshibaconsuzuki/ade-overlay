import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import type { ClipboardImageReader } from './html'
import type { HttpClient } from '../../shared/http-client'

export class UrlClipboardImageReader implements ClipboardImageReader {
  constructor(private readonly http: HttpClient) {}

  async read(source: string): Promise<Uint8Array> {
    let url: URL
    try {
      url = new URL(source.startsWith('//') ? `https:${source}` : source)
    } catch {
      throw new Error('Clipboard image source is not an absolute URL')
    }
    let data: Uint8Array
    if (url.protocol === 'file:') {
      try {
        data = await readFile(fileURLToPath(url))
      } catch {
        throw new Error('Unable to read clipboard image file')
      }
    } else if (['http:', 'https:', 'data:'].includes(url.protocol)) {
      try {
        const response = await this.http.fetch(url.href, {
          signal: AbortSignal.timeout(5_000),
        })
        if (!response.ok) throw new Error('Image request failed')
        data = new Uint8Array(await response.arrayBuffer())
      } catch {
        throw new Error('Unable to download clipboard image')
      }
    } else {
      throw new Error('Clipboard image URL scheme is unsupported')
    }
    // Clipboard image parts are static PNGs; Sharp reads the first frame by default.
    try {
      return await sharp(data).autoOrient().png().toBuffer()
    } catch {
      throw new Error('Clipboard image cannot be decoded')
    }
  }
}
