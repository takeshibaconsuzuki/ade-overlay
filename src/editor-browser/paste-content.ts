export interface PasteInput {
  text: string
  html: string
  images: Blob[]
  // Dropped files follow any text and images, keeping their names.
  files?: File[]
}

import type { PastePart } from '../shared/paste'
export type { PastePart } from '../shared/paste'
type SourcePart = { type: 'text' | 'image'; data: string | Blob }

export function parsePaste(input: PasteInput): SourcePart[] {
  const content: SourcePart[] = []
  let text = ''
  let preStart = Infinity
  let preEnd = 0
  const append = (value: string, pre = false) => {
    if (pre && value) {
      preStart = Math.min(preStart, text.length)
      preEnd = text.length + value.length
    }
    text += value
  }
  const flush = () => {
    // Trim surrounding HTML/layout whitespace, but never cross text that
    // came from <pre>, including whitespace-only text and trailing newlines.
    const start = Math.min(text.length - text.trimStart().length, preStart)
    const end = Math.max(text.trimEnd().length, preEnd)
    const value = text.slice(start, end)
    if (value) content.push({ type: 'text', data: value })
    text = ''
    preStart = Infinity
    preEnd = 0
  }
  let imageCount = 0
  if (input.html) {
    // Template contents stay inert: no scripts, styles or image requests.
    const template = document.createElement('template')
    template.innerHTML = input.html
    const base = template.content
      .querySelector('base[href]')
      ?.getAttribute('href')
    const visit = (node: Node, pre = false) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent ?? ''
        append(pre ? value : value.replace(/\s+/g, ' '), pre)
        return
      }
      if (!(node instanceof Element)) return
      const tag = node.tagName.toLowerCase()
      if (['script', 'style', 'head', 'template', 'noscript'].includes(tag))
        return
      if (
        node.hasAttribute('hidden') ||
        node.getAttribute('aria-hidden') === 'true'
      )
        return
      if (tag === 'img') {
        flush()
        imageCount++
        const raw =
          node.getAttribute('src') ?? node.getAttribute('data-src') ?? ''
        let source = raw
        try {
          // Never resolve a source-page URL against the editor's origin.
          source = new URL(
            raw.startsWith('//') ? `https:${raw}` : raw,
            base || undefined,
          ).href
        } catch {
          /* Retain unresolved URLs in their original positions. */
        }
        content.push({ type: 'image', data: source })
        return
      }
      const block =
        /^(address|article|aside|blockquote|div|dl|dt|dd|figure|figcaption|h[1-6]|li|main|ol|p|pre|section|table|tr|ul)$/.test(
          tag,
        )
      if (block && text && !text.endsWith('\n')) text += '\n'
      if (tag === 'br') append('\n', pre)
      for (const child of node.childNodes) visit(child, pre || tag === 'pre')
      if (tag === 'td' || tag === 'th') text += '\t'
      if (block && text && !text.endsWith('\n')) text += '\n'
    }
    for (const node of template.content.childNodes) visit(node)
    flush()
  }
  if (!imageCount && input.text)
    content.splice(0, content.length, { type: 'text', data: input.text })
  if (!imageCount) {
    for (const blob of input.images) content.push({ type: 'image', data: blob })
    if (input.text && input.images.length)
      console.warn(
        '[ADE paste] Clipboard image positions are unavailable without HTML; images follow the text.',
      )
  } else if (input.images.length) {
    // Multiple MIME representations are not multiple consecutive attachments.
    console.warn(
      '[ADE paste] Separate image bytes cannot be matched reliably to the HTML images; using the HTML order and sources.',
    )
  }
  return content
}

export async function readPaste(input: PasteInput): Promise<PastePart[]> {
  const [parts, files] = await Promise.all([
    readSources(input),
    Promise.all(
      (input.files ?? []).map(
        async (file): Promise<PastePart> => ({
          type: 'file',
          name: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
        }),
      ),
    ),
  ])
  return [...parts, ...files]
}

function readSources(input: PasteInput): Promise<PastePart[]> {
  // Promise.all keeps document order even if images finish in a different order.
  return Promise.all(
    parsePaste(input).map(async (part): Promise<PastePart> => {
      if (part.type === 'text')
        return { type: 'text', data: part.data as string }
      try {
        let blob: Blob
        if (part.data instanceof Blob) blob = part.data
        else if (/^data:image\//i.test(part.data)) {
          // Decode inline images locally; the workbench CSP may forbid even
          // a data: fetch. Base64 image bytes do not need a network request.
          const comma = part.data.indexOf(',')
          if (comma < 0) throw new Error('Invalid inline image')
          const encoded = decodeURIComponent(part.data.slice(comma + 1))
          const data = /;base64$/i.test(part.data.slice(0, comma))
            ? Uint8Array.from(atob(encoded), (character) =>
                character.charCodeAt(0),
              )
            : new TextEncoder().encode(encoded)
          return { type: 'image', data }
        } else {
          const url = new URL(part.data)
          if (!['https:', 'http:', 'blob:'].includes(url.protocol))
            throw new Error('Image source is missing, relative or unsupported')
          const response = await fetch(url, {
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: AbortSignal.timeout(10_000),
          })
          if (!response.ok)
            throw new Error(`Image fetch returned HTTP ${response.status}`)
          blob = await response.blob()
          if (!blob.type.startsWith('image/'))
            throw new Error('Image source did not return an image')
        }
        return { type: 'image', data: new Uint8Array(await blob.arrayBuffer()) }
      } catch (error) {
        // A later companion fetch can resolve URLs blocked by browser CORS/CSP.
        // Keep the image slot, never silently omit it or substitute its alt text.
        console.warn(
          '[ADE paste] Image bytes unavailable; retaining source URL:',
          part.data,
          error,
        )
        return {
          type: 'image',
          data: typeof part.data === 'string' ? part.data : '',
        }
      }
    }),
  )
}
