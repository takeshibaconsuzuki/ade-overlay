// Desktop IPC contract: safe to import without network schema initialization.
// Pastes and file drops share one contract. Files keep their names; the
// companion stores them and delivers supported image files as images.
export type PastePart =
  | { type: 'text'; data: string }
  | { type: 'image'; data: string | Uint8Array }
  | { type: 'file'; name: string; data: Uint8Array }

export const MAX_PASTE_BYTES = 32 * 1024 * 1024

export const pasteChannels = {
  reserve: 'editor:reserve-paste',
  paste: 'editor:paste',
}

export interface PasteBridge {
  // null releases an ordinary terminal's captured text through native paste.
  reservePaste(): Promise<string | null>
  paste(id: string, items: PastePart[]): Promise<void>
}

declare global {
  interface Window {
    adePaste?: PasteBridge
  }
}
