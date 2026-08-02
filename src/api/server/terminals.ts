import { z } from 'zod/v4'
import { defineSseEvents, SSE_SNAPSHOT_EVENT } from './sse'

export const TERMINALS_PATH = '/terminals'
export const TERMINAL_STREAM_PATH = TERMINALS_PATH
export const TERMINAL_SOCKET_VIEWER_QUERY = 'viewer'
export const TERMINAL_PASTE_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const TERMINAL_SOCKET_MAX_MESSAGE_BYTES = 32 * 1024 * 1024

export function terminalSocketPath(
  terminalId: string,
  viewerId?: string,
): string {
  const path = `${TERMINALS_PATH}/${encodeURIComponent(terminalId)}/socket`
  return viewerId
    ? `${path}?${TERMINAL_SOCKET_VIEWER_QUERY}=${encodeURIComponent(viewerId)}`
    : path
}

export const TERMINAL_SOCKET_ROUTE = `${TERMINALS_PATH}/:terminalId/socket`

export function parseTerminalSocketUrl(
  url: string | undefined,
): { terminalId: string; viewerId?: string } | null {
  if (!url) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(url, 'http://localhost')
  } catch {
    return null
  }

  const prefix = `${TERMINALS_PATH}/`
  const suffix = '/socket'
  const { pathname } = parsed
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null
  }

  const id = pathname.slice(prefix.length, -suffix.length)
  if (id.length === 0 || id.includes('/')) {
    return null
  }

  let terminalId: string
  try {
    terminalId = decodeURIComponent(id)
  } catch {
    return null
  }

  return {
    terminalId,
    viewerId:
      parsed.searchParams.get(TERMINAL_SOCKET_VIEWER_QUERY) ?? undefined,
  }
}

export type TerminalStatus = 'running' | 'exited'

export const TerminalStatus = z.enum(['running', 'exited'])

export const Terminal = z.object({
  terminalId: z.string(),
  worktreeId: z.string(),
  title: z.string().optional(),
  status: TerminalStatus,
})

export const TerminalListResponse = z.object({
  terminals: z.array(Terminal),
})

export const TerminalSnapshot = TerminalListResponse

export const TerminalStreamResponse = z
  .string()
  .describe('Server-sent terminal snapshot events.')

export const TerminalSseEvents = defineSseEvents({
  [SSE_SNAPSHOT_EVENT]: TerminalSnapshot,
})

export const TerminalCreateRequest = z.object({
  worktreeId: z.string().min(1),
  providerId: z.string().optional(),
  resumeChatId: z.string().optional(),
  title: z.string().optional(),
})

export const TerminalParams = z.object({
  terminalId: z.string().min(1),
})

export const TerminalPasteTextPart = z.object({
  type: z.literal('text'),
  text: z.string().max(TERMINAL_SOCKET_MAX_MESSAGE_BYTES),
})

export const TerminalPasteImagePart = z.object({
  type: z.literal('image'),
  mimeType: z
    .string()
    .max(128)
    .regex(/^image\/[a-z0-9.+-]+$/i),
  dataBase64: z
    .string()
    .max(Math.ceil((TERMINAL_PASTE_MAX_IMAGE_BYTES * 4) / 3) + 4),
  filename: z.string().min(1).max(255).optional(),
  alt: z.string().max(4096).optional(),
})

export const TerminalPastePart = z.discriminatedUnion('type', [
  TerminalPasteTextPart,
  TerminalPasteImagePart,
])

export const TerminalPasteMessage = z
  .object({
    type: z.literal('paste'),
    parts: z.array(TerminalPastePart).min(1).max(64),
    bracketedPasteMode: z.boolean(),
  })
  .refine(
    (message) =>
      new TextEncoder().encode(JSON.stringify(message)).byteLength <=
      TERMINAL_SOCKET_MAX_MESSAGE_BYTES,
    { message: 'Paste exceeds the terminal socket message limit' },
  )

export const TerminalSocketQuery = z.object({
  [TERMINAL_SOCKET_VIEWER_QUERY]: z.string().optional(),
})

export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | z.infer<typeof TerminalPasteMessage>
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }

export type TerminalServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'pong' }
  | { type: 'superseded' }

export const TerminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  TerminalPasteMessage,
  z.object({
    type: z.literal('resize'),
    cols: z.number(),
    rows: z.number(),
  }),
  z.object({ type: z.literal('ping') }),
])

export const TerminalServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number().nullable() }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('superseded') }),
])

export type Terminal = z.infer<typeof Terminal>
export type TerminalPastePart = z.infer<typeof TerminalPastePart>
export type TerminalPasteMessage = z.infer<typeof TerminalPasteMessage>
export type TerminalSnapshot = z.infer<typeof TerminalSnapshot>
export type TerminalSseEvents = typeof TerminalSseEvents
