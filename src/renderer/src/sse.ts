import { type SseEventSchemas, type SsePayload } from '../../api/server/sse'
import { logger } from './logger'

export function parseSsePayload<
  Schemas extends SseEventSchemas,
  EventName extends keyof Schemas & string,
>(
  schemas: Schemas,
  eventName: EventName,
  raw: string,
  stream: string,
): SsePayload<Schemas, EventName> | null {
  try {
    const result = schemas[eventName].safeParse(JSON.parse(raw))
    if (!result.success) {
      logger.error(
        { stream, event: eventName, err: result.error },
        'invalid sse payload',
      )
      return null
    }
    return result.data
  } catch (error) {
    logger.error(
      { stream, event: eventName, err: error },
      'failed to parse sse payload',
    )
    return null
  }
}
