import { request } from 'node:http'
import { Writable } from 'node:stream'
import { SERVER_ORIGIN } from '../api/server/config'
import { type LogLevel } from '../api/server/logger'
import { LOGS_PATH } from '../api/server/logs'

/**
 * Ships a Node process's Pino logs to the server's `POST /logs` endpoint so
 * processes that don't share the server's stdout (notably the spawned editor
 * Electron process) still land in one consolidated stream. This is the Node
 * counterpart to the renderer's HTTP log shipping (`src/renderer/src/logger`).
 *
 * Records are batched to keep request volume low and flushed on a short timer;
 * call `flushLogShipper` before the process exits to drain the buffer.
 */
const MAX_BATCH = 20
const FLUSH_DELAY_MS = 1000

const LEVEL_LABELS: Record<number, LogLevel> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

interface WireRecord {
  source: string
  level: LogLevel
  time: number
  msg?: string
  fields?: Record<string, unknown>
}

const queue: WireRecord[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> = Promise.resolve()

function scheduleFlush(): void {
  if (flushTimer) {
    return
  }
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DELAY_MS)
}

function flush(): Promise<void> {
  if (queue.length === 0) {
    return inFlight
  }
  const records = queue.splice(0, queue.length)
  inFlight = postBatch(records)
  return inFlight
}

function postBatch(records: WireRecord[]): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ records })
    const req = request(
      `${SERVER_ORIGIN}${LOGS_PATH}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume()
        response.on('end', resolve)
      },
    )
    req.on('error', (error) => {
      // Report transport failures on stderr only — never back through the
      // logger, which would recurse.
      console.error('[log transport] failed to ship logs', error)
      resolve()
    })
    req.end(body)
  })
}

function enqueue(record: WireRecord): void {
  queue.push(record)
  if (queue.length >= MAX_BATCH) {
    void flush()
  } else {
    scheduleFlush()
  }
}

/**
 * A Pino destination that converts each NDJSON log line into a wire record and
 * queues it for delivery. `source` tags every record's origin (e.g. `editor`).
 */
export function createLogShippingStream(source: string): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line) {
          continue
        }
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const { level, time, msg, ...fields } = parsed as {
          level: number
          time: number
          msg?: string
        } & Record<string, unknown>
        // pid/hostname are constant per process — drop them from the shipped
        // fields to keep records lean; `source` already identifies the origin.
        delete fields.pid
        delete fields.hostname
        enqueue({
          source,
          level: LEVEL_LABELS[level] ?? 'info',
          time,
          msg,
          fields: Object.keys(fields).length > 0 ? fields : undefined,
        })
      }
      callback()
    },
  })
}

/** Drains buffered records; await this before the process exits. */
export async function flushLogShipper(): Promise<void> {
  await flush()
  await inFlight
}
