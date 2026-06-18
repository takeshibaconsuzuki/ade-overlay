import { z } from 'zod/v4'
import { LOG_LEVELS } from './logger'

export const LOGS_PATH = '/logs'

export const LogRecord = z.object({
  source: z.string().optional(),
  level: z.enum(LOG_LEVELS),
  time: z.number(),
  msg: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  bindings: z.record(z.string(), z.unknown()).optional(),
})

export const IngestLogsRequest = z.object({
  records: z.array(LogRecord).max(1000),
})

export const IngestLogsResponse = z.object({
  received: z.number(),
})

export type LogRecord = z.infer<typeof LogRecord>
export type IngestLogsRequest = z.infer<typeof IngestLogsRequest>
