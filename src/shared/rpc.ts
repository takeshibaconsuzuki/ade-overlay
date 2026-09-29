import { z } from 'zod'

// Socket.IO owns correlation, acknowledgement timers and connection retries.
// This boundary owns application validation and cancellation of a caller's wait.
interface Socket {
  connected: boolean
  emit(event: string, ...args: unknown[]): unknown
  emitWithAck(event: string, ...args: unknown[]): Promise<unknown>
  timeout(ms: number): Socket
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

export function requestSpec<I, O>(
  event: string,
  input: z.ZodType<I>,
  output: z.ZodType<O>,
  timeout: number,
) {
  return { event, input, output, timeout }
}
export function eventSpec<T>(event: string, schema: z.ZodType<T>) {
  return { event, schema }
}

const replySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().max(4096) }),
])
const pending = new WeakMap<Socket, number>()

export async function callRpc<I, O>(
  socket: Socket,
  spec: ReturnType<typeof requestSpec<I, O>>,
  input: I,
  options: { signal?: AbortSignal; timeout?: number } = {},
): Promise<O> {
  options.signal?.throwIfAborted()
  if (!socket.connected) throw new Error('Disconnected from companion server.')
  const count = pending.get(socket) ?? 0
  if (count >= 32) throw new Error('Too many pending requests.')
  const value = spec.input.parse(input)
  pending.set(socket, count + 1)
  let abort: () => void = () => {}
  let disconnected: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(options.signal!.reason)
    disconnected = () =>
      reject(new Error('Disconnected from companion server.'))
    options.signal?.addEventListener('abort', abort, { once: true })
    socket.on('disconnect', disconnected)
  })
  try {
    const reply = replySchema.parse(
      await Promise.race([
        socket
          .timeout(options.timeout ?? spec.timeout)
          .emitWithAck(spec.event, value)
          .finally(() => {
            // Cancelling a caller's wait does not retire the wire acknowledgement.
            pending.set(socket, (pending.get(socket) ?? 1) - 1)
          }),
        cancelled,
      ]),
    )
    if (!reply.ok) throw new Error(reply.error)
    return spec.output.parse(reply.value)
  } finally {
    options.signal?.removeEventListener('abort', abort)
    socket.off('disconnect', disconnected)
  }
}

export function handleRpc<I, O>(
  socket: Socket,
  spec: ReturnType<typeof requestSpec<I, O>>,
  handler: (input: I) => O | Promise<O>,
  completed?: (elapsedMs: number, error?: unknown, result?: O) => void,
): void {
  socket.on(spec.event, (input, acknowledge) => {
    if (typeof acknowledge !== 'function') return
    const started = performance.now()
    void Promise.resolve()
      .then(() => handler(spec.input.parse(input)))
      .then((value) => {
        const result = spec.output.parse(value)
        completed?.(Math.round(performance.now() - started), undefined, result)
        if (socket.connected) acknowledge({ ok: true, value: result })
      })
      .catch((error: unknown) => {
        completed?.(Math.round(performance.now() - started), error)
        if (socket.connected)
          acknowledge({
            ok: false,
            error: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 4096),
          })
      })
  })
}

export function sendEvent<T>(
  socket: Socket,
  spec: ReturnType<typeof eventSpec<T>>,
  value: T,
): void {
  if (socket.connected) socket.emit(spec.event, spec.schema.parse(value))
}

export function listenEvent<T>(
  socket: Socket,
  spec: ReturnType<typeof eventSpec<T>>,
  listener: (value: T) => void,
  invalid: () => void,
): void {
  socket.on(spec.event, (value) => {
    const parsed = spec.schema.safeParse(value)
    if (parsed.success) listener(parsed.data)
    else invalid()
  })
}
