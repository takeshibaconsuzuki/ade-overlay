import sharp from 'sharp'
import type { ClipboardImageReader } from './html'
import type { ClipboardResourceReader } from './resource-reader'

export interface ClipboardImageEncoder {
  // Converts any decodable image bytes into a static PNG; rejects undecodable bytes.
  encode(data: Uint8Array): Promise<Uint8Array>
}

export class SharpImageEncoder implements ClipboardImageEncoder {
  async encode(data: Uint8Array): Promise<Uint8Array> {
    // Clipboard image parts are static PNGs; Sharp reads the first frame by default.
    try {
      return await sharp(data).autoOrient().png().toBuffer()
    } catch {
      throw new Error('Clipboard image cannot be decoded')
    }
  }
}

export class UrlClipboardImageReader implements ClipboardImageReader {
  constructor(
    private readonly resources: ClipboardResourceReader,
    private readonly encoder: ClipboardImageEncoder,
  ) {}

  async read(source: string): Promise<Uint8Array> {
    const { data } = await this.resources.read(source)
    return this.encoder.encode(data)
  }
}
