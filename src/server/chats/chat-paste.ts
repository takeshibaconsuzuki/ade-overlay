import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import filenamify from 'filenamify'
import writeFileAtomic from 'write-file-atomic'
import { MAX_PASTE_BYTES, type PastePart } from '../../shared/paste.ts'

export interface MaterializedPastePart {
  type: 'text' | 'image' | 'file'
  // Images and files are absolute paths on the companion/extension host.
  data: string
}

// Keep pasted and dropped content across companion restarts: a CLI can read an
// attachment only when the user eventually submits or restores the draft.
async function store(directory: string, filename: string, bytes: Uint8Array) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, filename)
  // Concurrent pastes may share content. Publish complete files atomically.
  await writeFileAtomic(path, Buffer.from(bytes), { mode: 0o600 })
  return path
}

// filenamify bounds UTF-16 length, but file systems bound UTF-8 bytes (255
// per component). Leave room for write-file-atomic's temporary suffix.
const MAX_NAME_BYTES = 200
function fileName(name: string): string {
  const safe = filenamify(name, {
    replacement: '_',
    maxLength: MAX_NAME_BYTES,
  })
  if (Buffer.byteLength(safe) <= MAX_NAME_BYTES) return safe
  let extension = extname(safe)
  if (Buffer.byteLength(extension) > 32) extension = ''
  let stem = ''
  // Truncate whole graphemes so no character or emoji is split.
  const segments = new Intl.Segmenter().segment(
    safe.slice(0, safe.length - extension.length),
  )
  for (const { segment } of segments) {
    if (Buffer.byteLength(stem + segment + extension) > MAX_NAME_BYTES) break
    stem += segment
  }
  return filenamify(stem + extension, { replacement: '_' })
}

// Stores images under `paste-images/` and other files under `paste-files/`.
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
      // Dropped files always carry bytes; only image sources can be URLs.
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
      const hash = createHash('sha256').update(bytes).digest('hex')
      const format = await fileTypeFromBuffer(bytes)
      if (format && ['png', 'jpg', 'gif', 'webp'].includes(format.ext)) {
        const path = join(directory, 'paste-images')
        return {
          type: 'image' as const,
          data: await store(path, `${hash}.${format.ext}`, bytes),
        }
      }
      if (item.type === 'image')
        throw new Error(
          'Unsupported clipboard image. Use PNG, JPEG, GIF or WebP.',
        )
      // Keep the original name for the chat; the content hash separates
      // different files that share one.
      return {
        type: 'file' as const,
        data: await store(
          join(directory, 'paste-files', hash),
          fileName(item.name),
          bytes,
        ),
      }
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
