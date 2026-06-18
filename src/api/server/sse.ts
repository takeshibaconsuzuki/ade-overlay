import { z } from 'zod/v4'

export const SSE_SNAPSHOT_EVENT = 'snapshot'

export type SseEventSchemas = Record<string, z.ZodType>

export type SsePayload<
  Schemas extends SseEventSchemas,
  EventName extends keyof Schemas & string,
> = z.infer<Schemas[EventName]>

export type SseMessage<Schemas extends SseEventSchemas> = {
  [EventName in keyof Schemas & string]: {
    type: EventName
    data: SsePayload<Schemas, EventName>
  }
}[keyof Schemas & string]

export function defineSseEvents<const Schemas extends SseEventSchemas>(
  schemas: Schemas,
): Schemas {
  return schemas
}
