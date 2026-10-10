import type { BirpcReturn } from 'birpc'
import pRetry from 'p-retry'
import WebSocket from 'ws'
import type { ConnectionState } from './api'
import {
  CONNECT_TIMEOUT_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_MIN_DELAY_MS,
} from '../desktop/constants'
import { MAX_RPC_PAYLOAD_BYTES } from './constants'
import { createRpcPeer } from './rpc'

interface ClientOptions {
  onStateChange?: (state: ConnectionState) => void
}

export interface RpcClient<Remote extends object, Local extends object> {
  readonly rpc: BirpcReturn<Remote, Local>
  readonly state: ConnectionState
  close(): Promise<void>
}

export function connectRpc<Remote extends object, Local extends object>(
  url: string,
  methods: Local,
  { onStateChange }: ClientOptions = {},
): RpcClient<Remote, Local> {
  const endpoint = new URL(url)
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.hash) {
    throw new Error(
      'The server URL must be a ws:// or wss:// URL without a fragment',
    )
  }

  const controller = new AbortController()
  let socket: WebSocket | undefined
  let rpc: BirpcReturn<Remote, Local> | undefined
  let state: ConnectionState = 'connecting'
  const setState = (next: ConnectionState) => {
    state = next
    onStateChange?.(next)
  }

  const done = pRetry(
    () =>
      new Promise<void>((_resolve, reject) => {
        setState('connecting')
        const current = new WebSocket(endpoint, {
          handshakeTimeout: CONNECT_TIMEOUT_MS,
          maxPayload: MAX_RPC_PAYLOAD_BYTES,
        })
        socket = current
        let lastError: Error | undefined
        current.on('error', (error) => {
          lastError = error
        })
        current.once('open', () => {
          rpc = createRpcPeer<Remote, Local>(current, methods)
          setState('connected')
        })
        current.once('close', () => {
          rpc = undefined
          socket = undefined
          reject(new Error('Server connection closed', { cause: lastError }))
        })
      }),
    {
      retries: Infinity,
      minTimeout: RETRY_MIN_DELAY_MS,
      maxTimeout: RETRY_MAX_DELAY_MS,
      randomize: true,
      signal: controller.signal,
      onFailedAttempt: () => {
        if (!controller.signal.aborted) setState('retrying')
      },
    },
  ).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error
  })

  return {
    get rpc() {
      if (!rpc || state !== 'connected') {
        throw new Error('Server is not connected')
      }
      return rpc
    },
    get state() {
      return state
    },
    async close(): Promise<void> {
      controller.abort()
      rpc?.$close(new Error('RPC client closed'))
      socket?.terminate()
      setState('closed')
      await done
    },
  }
}
