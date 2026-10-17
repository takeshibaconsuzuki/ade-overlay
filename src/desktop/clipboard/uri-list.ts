import { parse } from 'node:path'
import type {
  ClipboardItem,
  ClipboardNormalizer,
  ClipboardPart,
} from '../../shared/clipboard'
import type { ClipboardImageEncoder } from './image-reader'
import type { ClipboardResourceReader } from './resource-reader'

// Copied files and links arrive as a text/uri-list (RFC 2483): one URI per line, with # comments.
export class UriListClipboardNormalizer implements ClipboardNormalizer {
  readonly representation = 'text/uri-list'

  constructor(
    private readonly resources: ClipboardResourceReader,
    private readonly images: ClipboardImageEncoder,
  ) {}

  async normalize(item: ClipboardItem): Promise<ClipboardPart[]> {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      await item.read(this.representation),
    )
    const uris = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    if (uris.length === 0) throw new Error('Clipboard URI list is empty')
    // Images attach like any other pasted image; everything else is uploaded as a file.
    return Promise.all(
      uris.map(async (uri): Promise<ClipboardPart> => {
        const resource = await this.resources.read(uri)
        if (resource.mediaType?.startsWith('image/'))
          return {
            type: 'image',
            // Encoding produces a PNG regardless of the source format.
            name: `${parse(resource.name).name}.png`,
            data: await this.images.encode(resource.data),
          }
        return { type: 'file', name: resource.name, data: resource.data }
      }),
    )
  }
}
