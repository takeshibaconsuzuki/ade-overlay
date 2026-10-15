// Parts retain source order. Text is UTF-8; images are encoded PNG files.
export interface ClipboardPart {
  type: 'text' | 'image'
  data: Uint8Array
}

// Representations are alternatives for one item, not additional content to append.
export interface ClipboardItem {
  readonly types: readonly string[]
  read(type: string): Promise<Uint8Array>
}

export interface ClipboardSource {
  // Captures one clipboard snapshot; normalizers read representations from these items.
  read(): Promise<readonly ClipboardItem[]>
}

export interface ClipboardNormalizer {
  readonly representation: string
  // Produces ordered text and image parts. Formatting is defined by the normalizer.
  // Rejects when a required part cannot be resolved, before any content is pasted.
  normalize(item: ClipboardItem): Promise<ClipboardPart[]>
}
