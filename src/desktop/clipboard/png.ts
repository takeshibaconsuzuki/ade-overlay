import type {
  ClipboardItem,
  ClipboardNormalizer,
  ClipboardPart,
} from '../../shared/clipboard'

export class PngClipboardNormalizer implements ClipboardNormalizer {
  readonly representation = 'image/png'

  async normalize(item: ClipboardItem): Promise<ClipboardPart[]> {
    return [
      {
        type: 'image',
        name: 'image.png',
        data: await item.read(this.representation),
      },
    ]
  }
}
