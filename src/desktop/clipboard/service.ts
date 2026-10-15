import type {
  ClipboardNormalizer,
  ClipboardPart,
  ClipboardSource,
} from '../../shared/clipboard'
import type { DesktopClipboardMethods } from '../../shared/editor-rpc'
import { logger } from '../../shared/logger'

const log = logger.child({ component: 'clipboard' })

export class ClipboardService implements DesktopClipboardMethods {
  constructor(
    private readonly source: ClipboardSource,
    // First matching representation wins; alternatives are never appended or retried after failure.
    private readonly normalizers: readonly ClipboardNormalizer[],
  ) {}

  // Unsupported snapshots are logged and produce no parts; supported conversion failures reject.
  async readClipboard(): Promise<ClipboardPart[]> {
    const items = await this.source.read()
    const selectedNormalizers = items.map((item) => ({
      item,
      normalizer: this.normalizers.find((normalizer) =>
        item.types.includes(normalizer.representation),
      ),
    }))
    if (selectedNormalizers.every(({ normalizer }) => !normalizer)) {
      log.warn(
        {
          formats: items.map((item) => item.types),
          platform: process.platform,
        },
        'Paste contains no supported clipboard representations',
      )
      return []
    }
    // Do not silently drop items from a multi-item copy.
    try {
      if (selectedNormalizers.some(({ normalizer }) => !normalizer))
        throw new Error('Paste contains an unsupported clipboard item')
      const parts = await Promise.all(
        selectedNormalizers.map(({ item, normalizer }) =>
          normalizer!.normalize(item),
        ),
      )
      // Node Buffer subclasses cannot be decoded by the shared typed-array RPC codec.
      return parts
        .flat()
        .map((part) => ({ ...part, data: new Uint8Array(part.data) }))
    } catch (error) {
      log.warn({ err: error }, 'Clipboard conversion failed')
      throw error
    }
  }
}
