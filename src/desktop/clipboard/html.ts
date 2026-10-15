import { randomUUID } from 'node:crypto'
import { convert } from 'html-to-text'
import type {
  ClipboardItem,
  ClipboardNormalizer,
  ClipboardPart,
} from '../../shared/clipboard'

export interface ClipboardImageReader {
  // Resolves an image reference on the desktop and returns encoded PNG bytes.
  read(source: string): Promise<Uint8Array>
}

export class HtmlClipboardNormalizer implements ClipboardNormalizer {
  readonly representation = 'text/html'

  constructor(private readonly imageReader: ClipboardImageReader) {}

  async normalize(item: ClipboardItem): Promise<ClipboardPart[]> {
    const html = new TextDecoder().decode(await item.read(this.representation))
    const imageSources: string[] = []
    // Image markers retain their positions in the converted text for replacement with binary parts.
    const marker = `ADE_IMAGE_${randomUUID()}_`
    // Follow html-to-text defaults with targeted behavior changes only as necessary.
    const text = convert(html, {
      wordwrap: false,
      selectors: [{ selector: 'img', format: 'clipboardImage' }],
      formatters: {
        clipboardImage(element, _walk, builder) {
          const source: unknown = element.attribs?.src
          imageSources.push(typeof source === 'string' ? source : '')
          builder.addInline(`${marker}${imageSources.length - 1}_END`, {
            noWordTransform: true,
          })
        },
      },
    })
    const directImage =
      imageSources.length === 1 && item.types.includes('image/png')
    const imageBytes = await Promise.all(
      imageSources.map((source) => {
        if (directImage) return item.read('image/png')
        if (!source) throw new Error('Clipboard image has no source')
        return this.imageReader.read(source)
      }),
    )
    const parts: ClipboardPart[] = []
    let offset = 0
    for (const match of text.matchAll(new RegExp(`${marker}(\\d+)_END`, 'g'))) {
      const before = text.slice(offset, match.index)
      if (before)
        parts.push({ type: 'text', data: new TextEncoder().encode(before) })
      parts.push({ type: 'image', data: imageBytes[Number(match[1])] })
      offset = match.index + match[0].length
    }
    const after = text.slice(offset)
    if (after)
      parts.push({ type: 'text', data: new TextEncoder().encode(after) })
    return parts
  }
}
