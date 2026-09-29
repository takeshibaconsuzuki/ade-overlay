import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import writeFileAtomic from 'write-file-atomic'
import type { PastePart } from '../../shared/paste.ts'
import { MAX_PASTE_BYTES } from '../../shared/paste-schema.ts'

export interface MaterializedPastePart {
  type: 'text' | 'image'
  // Images are absolute paths on the companion/extension host.
  data: string
}

export async function materializePaste(
  items: readonly PastePart[],
  directory: string,
): Promise<MaterializedPastePart[]> {
  let remaining = MAX_PASTE_BYTES
  const account = (size: number) => {
    remaining -= size
    if (remaining < 0) throw new Error('Paste exceeds 32 MiB.')
  }
  const results = await Promise.allSettled(
    items.map(async (item) => {
      if (item.type === 'text') {
        account(Buffer.byteLength(item.data))
        return item
      }
      let bytes: Uint8Array
      if (typeof item.data !== 'string') {
        bytes = item.data
        account(bytes.byteLength)
      } else {
        const url = new URL(item.data)
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error(
            'Image source must be an HTTP(S) URL without credentials.',
          )
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          credentials: 'omit',
        })
        if (!response.ok || !response.body)
          throw new Error(`Image download failed: HTTP ${response.status}.`)
        const chunks: Uint8Array[] = []
        for await (const chunk of response.body) {
          account(chunk.byteLength)
          chunks.push(chunk)
        }
        bytes = Buffer.concat(chunks)
      }
      const format = await fileTypeFromBuffer(bytes)
      if (!format || !['png', 'jpg', 'gif', 'webp'].includes(format.ext))
        throw new Error(
          'Unsupported clipboard image. Use PNG, JPEG, GIF or WebP.',
        )
      const filename =
        createHash('sha256').update(bytes).digest('hex') + '.' + format.ext
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, filename)
      // Concurrent pastes may share an image. Publish complete files atomically.
      await writeFileAtomic(path, Buffer.from(bytes), { mode: 0o600 })
      // Keep images across companion restarts: a CLI can read an attachment only
      // when the user eventually submits or restores the draft.
      return { type: 'image' as const, data: path }
    }),
  )
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
}

// Providers choose frame boundaries. Do not append Enter or let clipboard
// control bytes terminate a frame and become terminal input. Tabs and line
// breaks remain literal.
export function bracketedPaste(
  parts: readonly MaterializedPastePart[],
): string {
  return parts
    .map((part) => {
      const text = part.data.replace(/\p{Cc}/gu, (character) =>
        '\t\r\n'.includes(character) ? character : '',
      )
      return text ? `\x1b[200~${text}\x1b[201~` : ''
    })
    .join('')
}
