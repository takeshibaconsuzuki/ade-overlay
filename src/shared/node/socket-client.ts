import { MAX_PASTE_MESSAGE_BYTES } from '../paste-schema.ts'
import { io } from 'socket.io-client'

export function createSocket(
  url: string,
  options: {
    token?: string
    timeout?: number
    reconnectDelay?: number
    maxReconnectDelay?: number
  } = {},
) {
  const endpoint = new URL(url)
  const socket = io(endpoint.origin, {
    path: endpoint.pathname,
    query: Object.fromEntries(endpoint.searchParams),
    addTrailingSlash: false,
    transports: ['websocket'],
    autoConnect: false,
    forceNew: true,
    autoUnref: true,
    timeout: options.timeout ?? 5000,
    reconnectionDelay: options.reconnectDelay ?? 500,
    reconnectionDelayMax: options.maxReconnectDelay ?? 10_000,
    randomizationFactor: 0,
    retries: 0,
    extraHeaders: options.token
      ? { Authorization: `Bearer ${options.token}` }
      : undefined,
    transportOptions: {
      websocket: { maxPayload: MAX_PASTE_MESSAGE_BYTES },
    },
  })
  // Commands belong to one connection. Reconnect reloads state, never mutations.
  socket.on('disconnect', () => {
    socket.sendBuffer = []
  })
  return socket
}
