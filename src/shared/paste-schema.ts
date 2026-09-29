import { z } from 'zod'
import type { PastePart } from './paste.ts'

export const MAX_PASTE_BYTES = 32 * 1024 * 1024
// Allow JSON framing/escaping in addition to the bounded binary/text content.
export const MAX_PASTE_MESSAGE_BYTES = 64 * 1024 * 1024
export const pasteItemsSchema: z.ZodType<PastePart[]> = z
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
            ? new TextEncoder().encode(item.data).byteLength
            : item.data.byteLength),
        0,
      ) <= MAX_PASTE_BYTES,
    'Paste exceeds 32 MiB.',
  )

export const terminalPasteSchema = z.object({
  terminalId: z.string().min(1).max(128),
  text: z.string().max(MAX_PASTE_BYTES),
})
