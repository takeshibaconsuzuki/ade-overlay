import { processes } from 'systeminformation'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProcessIdentity } from '../shared/chats.ts'

export interface ChatProcess extends ProcessIdentity {
  parentPid: number
  name: string
  command: string
}

const execute = promisify(execFile)

export function createProcessReader(scan = readFreshProcesses) {
  let reading: Promise<unknown> = Promise.resolve()
  let lastRead = -Infinity
  let snapshot:
    | { startedAt: number; entries: Map<number, ChatProcess> }
    | undefined
  return (notBefore = performance.now()): Promise<Map<number, ChatProcess>> => {
    const next = reading.then(async () => {
      if (snapshot && snapshot.startedAt >= notBefore) return snapshot.entries
      // systeminformation caches for 500ms. Pay that cooldown once per batch,
      // and timestamp the scan after waiting so arrivals during it can share.
      const wait = 501 - (performance.now() - lastRead)
      if (wait > 0) await delay(wait)
      const startedAt = performance.now()
      try {
        const entries = await scan()
        snapshot = { startedAt, entries }
        return entries
      } finally {
        lastRead = performance.now()
      }
    })
    reading = next.catch(() => {})
    return next
  }
}

// Share a scan only with requests admitted before it began. In particular, a
// newly launched terminal must never be checked against an older inventory.
export const readChatProcesses = createProcessReader()

async function readFreshProcesses(): Promise<Map<number, ChatProcess>> {
  const [result, starts] = await Promise.all([
    processes(),
    process.platform === 'win32'
      ? undefined
      : execute('ps', ['-axo', 'pid=,lstart='], {
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
          timeout: 1500,
          maxBuffer: 8 * 1024 * 1024,
        }).then(
          ({ stdout }) =>
            new Map(
              stdout
                .trim()
                .split('\n')
                .flatMap((line) => {
                  const match = /^\s*(\d+)\s+(.+)$/.exec(line)
                  return match
                    ? [
                        [
                          Number(match[1]),
                          match[2].trim().replace(/\s+/g, ' '),
                        ] as const,
                      ]
                    : []
                }),
            ),
        ),
  ])
  // A failed OS query must never look like every chat has exited.
  if (
    !result.list.some((entry) => entry.pid === process.pid) ||
    (starts && !starts.has(process.pid))
  )
    throw new Error('Could not read the local process inventory.')
  // On POSIX the library estimates start time from elapsed seconds, which can
  // drift between reads. ps lstart is the OS's stable process creation time.
  return new Map(
    result.list
      .map((entry) => ({
        ...entry,
        started: starts ? starts.get(entry.pid) : entry.started,
      }))
      .filter((entry) => entry.started)
      .map((entry) => [
        entry.pid,
        {
          pid: entry.pid,
          parentPid: entry.parentPid,
          startedAt: entry.started!,
          name: entry.name,
          command: `${entry.command} ${entry.params}`,
        },
      ]),
  )
}

export function sameProcess(a: ProcessIdentity, b?: ProcessIdentity): boolean {
  return b !== undefined && a.pid === b.pid && a.startedAt === b.startedAt
}

export function processAncestors(
  pid: number,
  entries: Map<number, ChatProcess>,
): ChatProcess[] {
  const result: ChatProcess[] = []
  const seen = new Set<number>()
  let entry = entries.get(pid)
  while (entry && !seen.has(entry.pid)) {
    seen.add(entry.pid)
    result.push(entry)
    entry = entries.get(entry.parentPid)
  }
  return result
}
