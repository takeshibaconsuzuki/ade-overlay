import { createBirpc, type BirpcReturn } from 'birpc'
import { deserializeError, serializeError } from 'serialize-error'
import SuperJSON, { type SuperJSONResult } from 'superjson'
import { RPC_TIMEOUT_MS } from './constants'

const codec = new SuperJSON()
// Preserve error subclasses, stacks, causes, and custom properties across peers.
codec.registerCustom(
  {
    isApplicable: (value): value is Error => value instanceof Error,
    serialize: (error) => serializeError(error) as SuperJSONResult['json'],
    deserialize: deserializeError,
  },
  'Error',
)

// A connection owns its receiver and must close its peer when the transport ends.
export interface RpcTransport {
  post(message: string): void | Promise<void>
  on(receive: (message: string) => void): void
  off(): void
  onError?(error: Error): void
}

export function createMessageRpc<Remote extends object, Local extends object>(
  transport: RpcTransport,
  methods: Local,
): BirpcReturn<Remote, Local> {
  const rpc = createBirpc<Remote, Local>(methods, {
    timeout: RPC_TIMEOUT_MS,
    serialize: (message) => codec.stringify(message),
    deserialize: (message) => codec.parse(message),
    post: (data: string) => {
      if (rpc.$closed) throw new Error('RPC connection closed')
      return transport.post(data)
    },
    on: (handler) =>
      transport.on((message) => {
        void Promise.resolve()
          .then(() => {
            if (!rpc.$closed) return handler(message)
          })
          .catch((error: unknown) => {
            const failure = deserializeError(error)
            rpc.$close(failure)
            transport.onError?.(failure)
          })
      }),
    off: () => transport.off(),
    resolver: (name, handler) => {
      if (!Object.hasOwn(methods, name) || typeof handler !== 'function') {
        return undefined
      }
      return async (...args: unknown[]) => {
        try {
          if (rpc.$closed) throw new Error('RPC connection closed')
          return await handler.apply(methods, args)
        } catch (error) {
          // Normalize even non-Error throws before birpc tests for failure.
          throw deserializeError(error)
        }
      }
    },
  })
  return rpc
}
