import type {
  ClipboardItem,
  ClipboardNormalizer,
  ClipboardPart,
} from '../../shared/clipboard'

export class TextClipboardNormalizer implements ClipboardNormalizer {
  readonly representation = 'text/plain'

  async normalize(item: ClipboardItem): Promise<ClipboardPart[]> {
    return [{ type: 'text', data: await item.read(this.representation) }]
  }
}
