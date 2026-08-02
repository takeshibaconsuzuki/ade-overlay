import {
  TERMINAL_PASTE_MAX_IMAGE_BYTES,
  type TerminalPastePart,
} from '../../../api/server/terminals'

export type ClipboardPastePart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      blob: Blob
      mimeType: string
      filename?: string
      alt?: string
    }

type ClipboardImagePastePart = Extract<ClipboardPastePart, { type: 'image' }>

type ClipboardSnapshot = {
  html: string
  text: string
  images: ClipboardImagePastePart[]
}

type RichToken =
  | { type: 'text'; text: string; preformatted: boolean }
  | { type: 'image'; element: HTMLImageElement; index: number }

type ResolvedRichPart =
  | {
      type: 'text'
      text: string
      preformatted: boolean
    }
  | ClipboardImagePastePart

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])
const IMAGE_FILE_EXTENSION = /\.(?:gif|jpe?g|png|webp)$/i
const IMAGE_FETCH_TIMEOUT_MS = 10_000
const PREFORMATTED_ELEMENTS = new Set(['CODE', 'PRE'])
const BLOCK_ELEMENTS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
])
const SKIPPED_ELEMENTS = new Set([
  'HEAD',
  'LINK',
  'META',
  'NOSCRIPT',
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
])

/**
 * Snapshot a native paste event synchronously, then resolve its alternative
 * clipboard representations into ordered generic parts.
 */
export function clipboardEventPasteParts(
  data: DataTransfer,
): Promise<ClipboardPastePart[]> {
  const files = [...data.files].filter(isSupportedImageFile)
  const images = (
    files.length > 0
      ? files
      : [...data.items]
          .map((item) => item.getAsFile())
          .filter(
            (file): file is File => file !== null && isSupportedImageFile(file),
          )
  ).map(fileToPastePart)
  return normalizeClipboard({
    html: data.getData('text/html'),
    text: data.getData('text/plain'),
    images,
  })
}

/**
 * Read the system clipboard for right-click paste. Clipboard representations
 * are alternatives, so they are normalized together rather than pasted once
 * per MIME type.
 */
export async function clipboardReadPasteParts(
  clipboard: Clipboard,
): Promise<ClipboardPastePart[]> {
  if (typeof clipboard.read !== 'function') {
    const text = await clipboard.readText()
    return text ? [{ type: 'text', text }] : []
  }

  let items: ClipboardItem[]
  try {
    items = await clipboard.read()
  } catch {
    const text = await clipboard.readText()
    return text ? [{ type: 'text', text }] : []
  }
  const images: ClipboardImagePastePart[] = []
  let html = ''
  let text = ''
  for (const item of items) {
    for (const type of item.types) {
      if (type === 'text/html' && !html) {
        html = await (await item.getType(type)).text()
      } else if (type === 'text/plain' && !text) {
        text = await (await item.getType(type)).text()
      }
    }
    const imageType = preferredClipboardImageType(item.types)
    if (imageType) {
      const blob = await item.getType(imageType)
      images.push({
        type: 'image',
        blob,
        mimeType: normalizedImageMimeType(blob.type || imageType),
      })
    }
  }
  return normalizeClipboard({ html, text, images })
}

export async function encodeTerminalPasteParts(
  parts: readonly ClipboardPastePart[],
): Promise<TerminalPastePart[]> {
  return Promise.all(
    parts.map(async (part): Promise<TerminalPastePart> => {
      if (part.type === 'text') {
        return part
      }
      if (
        part.blob.size === 0 ||
        part.blob.size > TERMINAL_PASTE_MAX_IMAGE_BYTES
      ) {
        throw new Error(
          `Pasted images must be at most ${TERMINAL_PASTE_MAX_IMAGE_BYTES} bytes`,
        )
      }
      const mimeType = normalizedImageMimeType(part.mimeType || part.blob.type)
      if (!isSupportedImageMimeType(mimeType)) {
        throw new Error(`Unsupported pasted image type: ${mimeType}`)
      }
      return {
        type: 'image',
        mimeType,
        dataBase64: await blobBase64(part.blob),
        filename: part.filename,
        alt: part.alt,
      }
    }),
  )
}

async function normalizeClipboard(
  snapshot: ClipboardSnapshot,
): Promise<ClipboardPastePart[]> {
  if (snapshot.html && /<img[\s>]/i.test(snapshot.html)) {
    const rich = await richHtmlParts(snapshot.html, snapshot.images)
    if (rich.some((part) => part.type === 'image')) {
      return rich
    }
  }

  if (snapshot.images.length > 0) {
    return snapshot.images
  }
  return snapshot.text ? [{ type: 'text', text: snapshot.text }] : []
}

async function richHtmlParts(
  html: string,
  nativeImages: ClipboardImagePastePart[],
): Promise<ClipboardPastePart[]> {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const tokens: RichToken[] = []
  let imageIndex = 0

  const appendText = (text: string, preformatted: boolean): void => {
    if (!text) {
      return
    }
    const previous = tokens.at(-1)
    if (previous?.type === 'text' && previous.preformatted === preformatted) {
      previous.text += text
    } else {
      tokens.push({ type: 'text', text, preformatted })
    }
  }

  const visit = (node: Node, preformatted = false): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.nodeValue ?? '', preformatted)
      return
    }
    if (!(node instanceof HTMLElement) || SKIPPED_ELEMENTS.has(node.tagName)) {
      return
    }
    if (node.tagName === 'BR') {
      appendText('\n', preformatted)
      return
    }
    if (node instanceof HTMLImageElement) {
      tokens.push({ type: 'image', element: node, index: imageIndex++ })
      return
    }

    const isBlock = BLOCK_ELEMENTS.has(node.tagName)
    if (isBlock) {
      appendText('\n', false)
    }
    const childPreformatted =
      preformatted || PREFORMATTED_ELEMENTS.has(node.tagName)
    for (const child of node.childNodes) {
      visit(child, childPreformatted)
    }
    if (isBlock) {
      appendText('\n', false)
    }
  }
  visit(document.body)

  const resolved = await Promise.all(
    tokens.map(async (token): Promise<ResolvedRichPart | null> => {
      if (token.type === 'text') {
        const text = token.preformatted
          ? token.text.replaceAll('\u00a0', ' ')
          : normalizeRichText(token.text)
        return text
          ? { type: 'text', text, preformatted: token.preformatted }
          : null
      }
      const native = nativeImages[token.index]
      if (native) {
        return {
          ...native,
          alt: token.element.alt || native.alt,
        }
      }
      const fetched = await fetchImagePart(token.element)
      return fetched?.type === 'text'
        ? { ...fetched, preformatted: false }
        : fetched
    }),
  )

  return trimAndMergeRichParts(resolved.filter((part) => part !== null))
}

async function fetchImagePart(
  element: HTMLImageElement,
): Promise<ClipboardPastePart | null> {
  const rawSrc =
    element.getAttribute('src') ||
    element.getAttribute('data-src') ||
    firstSrcsetUrl(element.getAttribute('srcset'))
  const src = rawSrc.startsWith('//') ? `https:${rawSrc}` : rawSrc
  if (!src || !/^(?:https?:|data:|blob:)/i.test(src)) {
    return imageAltFallback(element)
  }

  try {
    const response = await fetch(src, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      return imageAltFallback(element)
    }
    const contentLength = Number(response.headers.get('content-length'))
    if (
      Number.isFinite(contentLength) &&
      contentLength > TERMINAL_PASTE_MAX_IMAGE_BYTES
    ) {
      return imageAltFallback(element)
    }
    const blob = await response.blob()
    const mimeType = normalizedImageMimeType(blob.type)
    if (
      blob.size === 0 ||
      blob.size > TERMINAL_PASTE_MAX_IMAGE_BYTES ||
      !isSupportedImageMimeType(mimeType)
    ) {
      return imageAltFallback(element)
    }
    return {
      type: 'image',
      blob,
      mimeType,
      filename: filenameFromUrl(src),
      alt: element.alt || undefined,
    }
  } catch {
    return imageAltFallback(element)
  }
}

function imageAltFallback(
  element: HTMLImageElement,
): ClipboardPastePart | null {
  const alt = element.alt.trim()
  return alt ? { type: 'text', text: alt } : null
}

function trimAndMergeRichParts(
  parts: readonly ResolvedRichPart[],
): ClipboardPastePart[] {
  const trimmed = [...parts]
  while (trimmed[0]?.type === 'text' && !trimmed[0].preformatted) {
    trimmed[0].text = trimmed[0].text.replace(/^\s+/, '')
    if (trimmed[0].text) {
      break
    }
    trimmed.shift()
  }
  while (true) {
    const last = trimmed.at(-1)
    if (last?.type !== 'text' || last.preformatted) {
      break
    }
    last.text = last.text.replace(/\s+$/, '')
    if (last.text) {
      break
    }
    trimmed.pop()
  }

  const merged: ClipboardPastePart[] = []
  for (const part of trimmed) {
    const output =
      part.type === 'text' ? ({ type: 'text', text: part.text } as const) : part
    const previous = merged.at(-1)
    if (output.type === 'text' && previous?.type === 'text') {
      previous.text += output.text
    } else {
      merged.push(output)
    }
  }
  return merged.filter((part) => part.type === 'image' || part.text.length > 0)
}

function normalizeRichText(text: string): string {
  return text
    .replaceAll('\u00a0', ' ')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\r?\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

function isSupportedImageFile(file: File): boolean {
  const mimeType = normalizedImageMimeType(file.type)
  if (bareMimeType(file.type).startsWith('image/')) {
    return isSupportedImageMimeType(mimeType)
  }
  return (
    isSupportedImageMimeType(mimeType) || IMAGE_FILE_EXTENSION.test(file.name)
  )
}

function fileToPastePart(file: File): ClipboardImagePastePart {
  const fileMimeType = normalizedImageMimeType(file.type)
  return {
    type: 'image',
    blob: file,
    mimeType: isSupportedImageMimeType(fileMimeType)
      ? fileMimeType
      : mimeTypeFromName(file.name),
    filename: file.name,
  }
}

function normalizedImageMimeType(type: string): string {
  const mediaType = bareMimeType(type)
  return mediaType.startsWith('image/') ? mediaType : 'image/unknown'
}

function isSupportedImageMimeType(type: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(bareMimeType(type))
}

function preferredClipboardImageType(
  types: readonly string[],
): string | undefined {
  const imageTypes = types.filter(isSupportedImageMimeType)
  return (
    imageTypes.find((type) => bareMimeType(type) === 'image/png') ??
    imageTypes[0]
  )
}

function bareMimeType(type: string): string {
  return type.split(';', 1)[0].trim().toLowerCase()
}

function mimeTypeFromName(name: string): string {
  const extension = name.split('.').at(-1)?.toLowerCase()
  const types: Record<string, string> = {
    apng: 'image/apng',
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    heic: 'image/heic',
    heif: 'image/heif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    ico: 'image/x-icon',
    png: 'image/png',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp',
  }
  return types[extension ?? ''] ?? 'image/unknown'
}

function firstSrcsetUrl(srcset: string | null): string {
  return srcset?.split(',', 1)[0]?.trim().split(/\s+/, 1)[0] ?? ''
}

function filenameFromUrl(src: string): string | undefined {
  try {
    const name = new URL(src).pathname.split('/').at(-1)
    return name ? decodeURIComponent(name).slice(0, 255) : undefined
  } catch {
    return undefined
  }
}

async function blobBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)))
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Failed to read pasted image')),
    )
    reader.readAsDataURL(blob)
  })
  const comma = dataUrl.indexOf(',')
  if (comma === -1) {
    throw new Error('Failed to encode pasted image')
  }
  return dataUrl.slice(comma + 1)
}
