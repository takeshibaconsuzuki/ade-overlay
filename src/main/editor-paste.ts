import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pasteChannels } from '../shared/paste.ts'

const itemsSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), data: z.string() }),
      z.object({
        type: z.literal('image'),
        data: z.union([z.string(), z.instanceof(Uint8Array)]),
      }),
    ]),
  )
  .max(1024)
  .refine(
    (items) =>
      items.reduce(
        (size, item) =>
          size +
          (typeof item.data === 'string'
            ? item.data.length * 2
            : item.data.byteLength),
        0,
      ) <=
      32 * 1024 * 1024,
    'Paste exceeds 32 MiB.',
  )

// Reservations belong to one document. They never re-query focus on submission.
export function installEditorPaste(
  contents: WebContents,
  isActive: () => boolean,
  isEditorUrl: (url: URL | null) => boolean,
  target: () => Promise<string | null>,
): () => void {
  let generation = 0
  let pending = 0
  const reservations = new Map<
    string,
    { terminalId: string; expires: number }
  >()
  const assertSender = (event: IpcMainInvokeEvent) => {
    if (
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      !isActive() ||
      !isEditorUrl(URL.parse(contents.getURL()))
    )
      throw new Error('Untrusted paste caller.')
  }
  const expire = () => {
    for (const [id, reservation] of reservations)
      if (reservation.expires <= Date.now()) reservations.delete(id)
  }
  contents.ipc.handle(
    pasteChannels.reserve,
    async (event, trustedPaste: unknown) => {
      assertSender(event)
      expire()
      if (pending + reservations.size >= 32)
        throw new Error('Too many pending pastes.')
      const document = generation
      pending++
      try {
        if (
          trustedPaste !== true &&
          (await contents.executeJavaScript(
            'navigator.userActivation.isActive',
          )) !== true
        )
          throw new Error('Paste requires a user gesture.')
        const terminalId = await target()
        assertSender(event)
        if (generation !== document)
          throw new Error('The editor document changed.')
        if (terminalId === null) return null
        const id = randomUUID()
        reservations.set(id, { terminalId, expires: Date.now() + 30_000 })
        return id
      } finally {
        pending--
      }
    },
  )
  contents.ipc.handle(
    pasteChannels.paste,
    (event, id: unknown, input: unknown) => {
      assertSender(event)
      expire()
      const reservation =
        typeof id === 'string' ? reservations.get(id) : undefined
      if (!reservation)
        throw new Error('The paste reservation is invalid or expired.')
      reservations.delete(id as string)
      const items = itemsSchema.parse(input)
      // Diagnostic only. The reserved identity is available here for future delivery.
      console.info(`[ADE paste: ${reservation.terminalId}]`, items)
    },
  )
  const navigate = (
    _event: unknown,
    _url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (mainFrame && !inPlace) {
      generation++
      reservations.clear()
    }
  }
  contents.on('did-start-navigation', navigate)
  return () => {
    generation++
    reservations.clear()
    contents.removeListener('did-start-navigation', navigate)
    if (!contents.isDestroyed()) {
      contents.ipc.removeHandler(pasteChannels.reserve)
      contents.ipc.removeHandler(pasteChannels.paste)
    }
  }
}
