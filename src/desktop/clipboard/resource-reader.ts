import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import mime from 'mime'
import type { HttpClient } from '../../shared/http-client'

export interface ClipboardResource {
  // Non-empty file name suggested by the source, without directories; may be unsuitable for a file system.
  readonly name: string
  // Media type from the file extension when it has one, otherwise as declared by the source.
  readonly mediaType: string | undefined
  readonly data: Uint8Array
}

export interface ClipboardResourceReader {
  // Resolves a URL on the desktop and returns its bytes.
  read(source: string): Promise<ClipboardResource>
}

const DATA_URL_DEFAULT_MEDIA_TYPE = 'text/plain'

function declaredDataUrlMediaType(url: URL): string {
  const header = url.pathname.slice(0, url.pathname.indexOf(','))
  const mediaType = header.split(';')[0].trim().toLowerCase()
  return mediaType || DATA_URL_DEFAULT_MEDIA_TYPE
}

const UNNAMED_RESOURCE = 'clipboard'

// Sources without a file name share one name regardless of their origin, keeping an
// extension from the media type when it is known.
function unnamedResource(mediaType: string | undefined): string {
  const extension = mediaType ? mime.getExtension(mediaType) : null
  return extension ? `${UNNAMED_RESOURCE}.${extension}` : UNNAMED_RESOURCE
}

function urlFileName(url: URL): string | undefined {
  const segment = url.pathname.split('/').filter(Boolean).at(-1)
  if (segment === undefined) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export class UrlClipboardResourceReader implements ClipboardResourceReader {
  constructor(private readonly http: HttpClient) {}

  async read(source: string): Promise<ClipboardResource> {
    let url: URL
    try {
      url = new URL(source.startsWith('//') ? `https:${source}` : source)
    } catch {
      throw new Error('Clipboard resource is not an absolute URL')
    }
    if (url.protocol === 'file:') {
      const path = fileURLToPath(url)
      let data: Uint8Array
      try {
        data = await readFile(path)
      } catch {
        throw new Error('Unable to read clipboard file')
      }
      const name = basename(path) || unnamedResource(undefined)
      return { name, mediaType: mime.getType(name) ?? undefined, data }
    }
    if (!['http:', 'https:', 'data:'].includes(url.protocol))
      throw new Error('Clipboard resource URL scheme is unsupported')
    let data: Uint8Array
    let headerType: string | undefined
    try {
      const response = await this.http.fetch(url.href, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error('Resource request failed')
      data = new Uint8Array(await response.arrayBuffer())
      headerType = response.headers.get('content-type')?.split(';')[0].trim()
    } catch {
      throw new Error('Unable to download clipboard resource')
    }
    const declared =
      url.protocol === 'data:' ? declaredDataUrlMediaType(url) : headerType
    const name = url.protocol === 'data:' ? undefined : urlFileName(url)
    if (name !== undefined)
      return { name, mediaType: mime.getType(name) ?? declared, data }
    return { name: unnamedResource(declared), mediaType: declared, data }
  }
}
