import { createBirpc, type BirpcReturn } from 'birpc'
import { deserializeError, serializeError } from 'serialize-error'
import WebSocket, { type RawData } from 'ws'
import { HEARTBEAT_INTERVAL_MS, RPC_TIMEOUT_MS } from './constants'

function serialize(message: Record<string, unknown>): string {
  if (message.t === 's' && Object.hasOwn(message, 'e')) {
    return JSON.stringify({ ...message, e: serializeError(message.e) })
  }
  return JSON.stringify(message)
}

function deserialize(data: string): Record<string, unknown> {
  const message = JSON.parse(data) as Record<string, unknown> | null
  if (
    !message ||
    typeof message !== 'object' ||
    (message.t !== 'q' && message.t !== 's') ||
    (message.t === 'q' &&
      (typeof message.m !== 'string' || !Array.isArray(message.a))) ||
    (message.t === 's' && typeof message.i !== 'string') ||
    (message.i !== undefined && typeof message.i !== 'string')
  ) {
    throw new Error('Invalid RPC message')
  }
  if (message.t === 's' && Object.hasOwn(message, 'e')) {
    message.e = deserializeError(message.e)
  }
  return message
}

export function createRpcPeer<Remote extends object, Local extends object>(
  socket: WebSocket,
  methods: Local,
): BirpcReturn<Remote, Local> {
  let receive: (data: string) => void = () => {}
  const rpc = createBirpc<Remote, Local>(methods, {
    timeout: RPC_TIMEOUT_MS,
    serialize,
    deserialize,
    post: (data: string) =>
      new Promise<void>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error('RPC connection is not open'))
          return
        }
        socket.send(data, (error) => (error ? reject(error) : resolve()))
      }),
    on: (handler) => {
      receive = handler
    },
    resolver: (name, handler) => {
      if (!Object.hasOwn(methods, name) || typeof handler !== 'function') {
        return undefined
      }
      return async (...args: unknown[]) => {
        try {
          return await handler.apply(methods, args)
        } catch (error) {
          // Normalize even non-Error throws before birpc tests for failure.
          throw deserializeError(error)
        }
      }
    },
  })

  const onMessage = (data: RawData) => {
    // EventEmitter does not observe rejected async message handlers.
    void Promise.resolve()
      .then(() => receive(data.toString()))
      .catch(() => socket.terminate())
  }
  let alive = true
  const onPong = () => {
    alive = true
  }
  const onError = () => socket.terminate()
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate()
      return
    }
    if (socket.readyState === WebSocket.OPEN) {
      alive = false
      socket.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()

  socket.on('message', onMessage)
  socket.on('pong', onPong)
  socket.on('error', onError)
  socket.once('close', () => {
    clearInterval(heartbeat)
    socket.off('message', onMessage)
    socket.off('pong', onPong)
    socket.off('error', onError)
    rpc.$close(new Error('RPC connection disconnected'))
  })

  return rpc
}
