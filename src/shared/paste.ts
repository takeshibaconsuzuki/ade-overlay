// Desktop IPC contract: safe to import without network schema initialization.
export type PastePart =
  | { type: 'text'; data: string }
  | { type: 'image'; data: string | Uint8Array }

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
