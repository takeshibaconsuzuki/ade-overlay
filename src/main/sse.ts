import { request, type ClientRequest, type IncomingMessage } from 'node:http'
import { type Logger } from '../api/server/logger'
import { type SseEventSchemas, type SseMessage } from '../api/server/sse'

type SseClient = {
  close: () => void
  request: ClientRequest
}

export function connectSseClient<Schemas extends SseEventSchemas>({
  log,
  onEnd,
  onError,
  onOpen,
  onMessage,
  schemas,
  stream,
  url,
}: {
  log: Logger
  onEnd: () => void
  onError: (error: Error) => void
  onOpen: (response: IncomingMessage) => void
  onMessage: (message: SseMessage<Schemas>) => void
  schemas: Schemas
  stream: string
  url: URL
}): SseClient {
  const commandRequest = request(url, (response) => {
    onOpen(response)
    response.setEncoding('utf8')
    let buffer = ''
    response.on('data', (chunk: string) => {
      buffer += chunk
      let delimiterIndex = buffer.indexOf('\n\n')
      while (delimiterIndex >= 0) {
        handleSseFrame({
          frame: buffer.slice(0, delimiterIndex),
          log,
          onMessage,
          schemas,
          stream,
        })
        buffer = buffer.slice(delimiterIndex + 2)
        delimiterIndex = buffer.indexOf('\n\n')
      }
    })
    response.on('end', onEnd)
  })

  commandRequest.on('error', onError)
  commandRequest.end()
  return {
    close: () => commandRequest.destroy(),
    request: commandRequest,
  }
}

function handleSseFrame<Schemas extends SseEventSchemas>({
  frame,
  log,
  onMessage,
  schemas,
  stream,
}: {
  frame: string
  log: Logger
  onMessage: (message: SseMessage<Schemas>) => void
  schemas: Schemas
  stream: string
}): void {
  const lines = frame.split('\n')
  const event = lines
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim()
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n')

  if (!event || !data) {
    return
  }

  const schema = schemas[event]
  if (!schema) {
    log.warn({ event, stream }, 'unknown sse event')
    return
  }

  try {
    const result = schema.safeParse(JSON.parse(data))
    if (!result.success) {
      log.error({ err: result.error, event, stream }, 'invalid sse payload')
      return
    }
    onMessage({
      data: result.data,
      type: event,
    } as SseMessage<Schemas>)
  } catch (error) {
    log.error({ err: error, event, stream }, 'failed to parse sse payload')
  }
}
