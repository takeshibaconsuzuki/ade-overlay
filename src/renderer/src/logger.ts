import pino from 'pino'
import { SERVER_ORIGIN } from '../../api/server/config'
import { ingestLogs, type IngestLogsData } from '../../api/server/generated'
import { type Logger, type LogLevel } from '../../api/server/logger'
import { LOGS_PATH } from '../../api/server/logs'

/**
 * Renderer logger. Uses Pino's browser build so the UI shares the same library
 * and structured API as the server, and is typed as the shared `Logger`
 * interface so the implementation can be swapped freely.
 *
 * Records at `TRANSMIT_LEVEL` and above are also shipped to the server's
 * `POST /logs` endpoint (batched) so all logs are consolidated server-side,
 * while still printing to the devtools console for local debugging.
 */
const TRANSMIT_LEVEL: LogLevel = 'info'
const MAX_BATCH = 20
const FLUSH_DELAY_MS = 1000

type WireRecord = IngestLogsData['body']['records'][number]

const queue: WireRecord[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(): void {
  if (flushTimer) {
    return
  }
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DELAY_MS)
}

async function flush(): Promise<void> {
  if (queue.length === 0) {
    return
  }
  const records = queue.splice(0, queue.length)
  const { error } = await ingestLogs({ body: { records } })
  if (error) {
    // Report transport failures via the console only — never back through the
    // logger, which would recurse.
    console.error('[log transport] failed to ship logs', error)
  }
}

function enqueue(record: WireRecord): void {
  queue.push(record)
  if (queue.length >= MAX_BATCH) {
    void flush()
  } else {
    scheduleFlush()
  }
}

// Best-effort delivery of any buffered records when the page is hidden/closed,
// where an async fetch would be cancelled.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (queue.length === 0) {
      return
    }
    const records = queue.splice(0, queue.length)
    navigator.sendBeacon?.(
      `${SERVER_ORIGIN}${LOGS_PATH}`,
      new Blob([JSON.stringify({ records })], { type: 'application/json' }),
    )
  })
}

/**
 * Make log fields JSON-safe before shipping. In particular, `Error` instances
 * have non-enumerable `message`/`stack`, so a raw `JSON.stringify` would reduce
 * them to `{}` and lose the failure reason — expand them to plain objects.
 */
function toSerializable(fields: unknown): Record<string, unknown> {
  try {
    return JSON.parse(
      JSON.stringify(fields, (_key, value) =>
        value instanceof Error
          ? { name: value.name, message: value.message, stack: value.stack }
          : value,
      ),
    )
  } catch {
    return { unserializable: true }
  }
}

// A per-renderer-boot id. Shipped renderer logs are re-emitted server-side under
// the main process pid, so without this every window collapses into one
// indistinguishable source. Binding it lets a post-mortem separate lines by the
// window/renderer that produced them.
const RENDERER_ID = crypto.randomUUID().slice(0, 8)

export const logger: Logger = pino({
  name: 'renderer',
  level: import.meta.env.DEV ? 'debug' : 'info',
  browser: {
    transmit: {
      level: TRANSMIT_LEVEL,
      send: (_level, logEvent) => {
        const [first, second] = logEvent.messages
        const hasFields = typeof first === 'object' && first !== null
        enqueue({
          level: logEvent.level.label as LogLevel,
          time: logEvent.ts,
          msg: (hasFields ? second : first) as string | undefined,
          fields: hasFields ? toSerializable(first) : undefined,
          bindings: Object.assign(
            { renderer: RENDERER_ID },
            ...(logEvent.bindings ?? []),
          ),
        })
      },
    },
  },
})
