import { clipboard } from 'electron'
import type { ClipboardSource } from '../../shared/clipboard'

export class ElectronClipboardSource implements ClipboardSource {
  async read() {
    return (await clipboard.read()).map((item) => ({
      types: item.types,
      async read(type: string): Promise<Uint8Array> {
        const value = await item.getType(type)
        if (!(value instanceof Blob))
          throw new Error('Clipboard representation is not binary data')
        return new Uint8Array(await value.arrayBuffer())
      },
    }))
  }
}
