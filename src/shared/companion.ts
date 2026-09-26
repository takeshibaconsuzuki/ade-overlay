export const COMPANION_PROTOCOL_VERSION = 1
export const DEFAULT_COMPANION_PORT = 4317
export const DEFAULT_COMPANION_URL = `ws://127.0.0.1:${DEFAULT_COMPANION_PORT}/companion`
export const MAX_MESSAGE_BYTES = 16 * 1024

export const companionChannels = {
  status: 'companion:status',
  getStatus: 'companion:get-status',
  reconnect: 'companion:reconnect',
} as const

export interface CompanionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  url: string
  error?: string
}

export interface PingResult {
  roundTripMs: number
}

export interface CompanionAPI {
  getStatus(): Promise<CompanionStatus>
  reconnect(): Promise<CompanionStatus>
  onStatus(callback: (status: CompanionStatus) => void): () => void
}

export type ClientMessage = { type: 'ping'; id: string }
export type ServerMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'pong'; id: string }
  | { type: 'error'; message: string }

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

export function parseClientMessage(text: string): ClientMessage | null {
  const value = parseObject(text)
  if (value?.type === 'ping' && isId(value.id)) {
    return { type: 'ping', id: value.id }
  }
  return null
}

export function parseServerMessage(text: string): ServerMessage | null {
  const value = parseObject(text)
  if (!value) return null
  if (value.type === 'hello' && Number.isInteger(value.protocolVersion)) {
    return {
      type: 'hello',
      protocolVersion: value.protocolVersion as number,
    }
  }
  if (value.type === 'pong' && isId(value.id)) {
    return { type: 'pong', id: value.id }
  }
  if (value.type === 'error' && typeof value.message === 'string') {
    return { type: 'error', message: value.message }
  }
  return null
}

export function normalizeCompanionUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Enter a valid WebSocket URL.')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(
      'Enter a valid WebSocket URL, such as ' + DEFAULT_COMPANION_URL,
    )
  }
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/companion'
  ) {
    throw new Error(
      'Use a ws:// or wss:// URL ending in /companion, without credentials or a query.',
    )
  }
  return url.href
}
