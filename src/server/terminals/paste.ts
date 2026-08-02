export type MaterializedTerminalPastePart =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'image'
      path: string
      mimeType: string
      alt?: string
    }

export type TerminalPasteAction = {
  type: 'paste'
  text: string
}

/**
 * Provider-owned translation from generic paste parts to terminal actions.
 * Providers may diverge here when their TUIs gain a native image protocol.
 */
export type TerminalPasteProvider = (
  parts: readonly MaterializedTerminalPastePart[],
) => readonly TerminalPasteAction[]

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

/**
 * Both current TUIs recognize a bracketed-pasted local image path as an image
 * attachment. The provider opt-in remains explicit even though they currently
 * share this implementation.
 */
export const pasteTextAndImagePaths: TerminalPasteProvider = (parts) =>
  parts
    .map((part): TerminalPasteAction | null => {
      const text =
        part.type === 'text'
          ? part.text
          : SUPPORTED_IMAGE_MIME_TYPES.has(part.mimeType.toLowerCase())
            ? part.path
            : part.alt
      return text ? { type: 'paste', text } : null
    })
    .filter((action): action is TerminalPasteAction => action !== null)

export function terminalPasteInput(
  text: string,
  bracketedPasteMode: boolean,
): string {
  const normalized = text.replace(/\r?\n/g, '\r')
  return bracketedPasteMode ? `\x1b[200~${normalized}\x1b[201~` : normalized
}
