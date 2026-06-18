import { z } from 'zod/v4'
import { defineSseEvents, SSE_SNAPSHOT_EVENT } from './sse'

export const TERMINALS_PATH = '/terminals'
export const TERMINAL_STREAM_PATH = TERMINALS_PATH
export const TERMINAL_SOCKET_VIEWER_QUERY = 'viewer'

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
  providerId: z.string(),
  sessionId: z.string().optional(),
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
  resumeSessionId: z.string().optional(),
  title: z.string().optional(),
})

export const TerminalParams = z.object({
  terminalId: z.string().min(1),
})

export const TerminalSocketQuery = z.object({
  [TERMINAL_SOCKET_VIEWER_QUERY]: z.string().optional(),
})

export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }

export type TerminalServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'pong' }
  | { type: 'superseded' }

export const TerminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
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
export type TerminalSnapshot = z.infer<typeof TerminalSnapshot>
export type TerminalSseEvents = typeof TerminalSseEvents
