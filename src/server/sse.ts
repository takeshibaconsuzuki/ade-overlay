import { type FastifyReply, type FastifyRequest } from 'fastify'

type SseStream = {
  send: (eventName: string, data: unknown) => void
  onClose: (cleanup: () => void) => void
}

export function createSseStream(
  request: FastifyRequest,
  reply: FastifyReply,
): SseStream {
  reply.hijack()

  const headers: Record<string, string> = {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
  }
  const { origin } = request.headers
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers.vary = 'Origin'
  }
  reply.raw.writeHead(200, headers)

  const cleanups: Array<() => void> = []
  const keepAlive = setInterval(() => {
    reply.raw.write(': keep-alive\n\n')
  }, 30_000)
  cleanups.push(() => clearInterval(keepAlive))
  reply.raw.on('close', () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
  })

  return {
    send(eventName, data) {
      reply.raw.write(`event: ${eventName}\n`)
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
    },
    onClose(cleanup) {
      cleanups.push(cleanup)
    },
  }
}
