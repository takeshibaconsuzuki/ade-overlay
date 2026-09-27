import { pathToFileURL } from 'node:url'
import { chatProvider } from './chat-providers.ts'
import { processAncestors, readChatProcesses } from './chat-processes.ts'

export async function reportChatActivity(providerId: string): Promise<void> {
  const {
    ADE_CHAT_ENDPOINT: endpoint,
    ADE_CHAT_ACTIVITY_TOKEN: token,
    ADE_TERMINAL_ID: terminalId,
  } = process.env
  const provider = chatProvider(providerId)
  if (!endpoint || !token || !terminalId || !provider) return
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return
  const observedAt = Date.now()
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > 1024 * 1024) return
    chunks.push(chunk)
  }
  const activity = provider.activity(
    JSON.parse(Buffer.concat(chunks, length).toString('utf8')),
  )
  if (!activity) return
  const entries = await readChatProcesses()
  const owner = processAncestors(process.ppid, entries).find((entry) =>
    provider.isProcess(entry),
  )
  if (!owner) return
  await fetch(new URL('/activity', url), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider: provider.id,
      terminalId,
      ...activity,
      observedAt,
      metadataRoot: provider.metadataRoot(process.env),
      process: { pid: owner.pid, startedAt: owner.startedAt },
    }),
    signal: AbortSignal.timeout(1000),
  }).then((response) => response.body?.cancel())
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Hooks must not delay or change provider decisions when ADE is unavailable.
  const deadline = setTimeout(() => process.exit(0), 2000)
  void reportChatActivity(process.argv[2])
    .catch(() => {})
    .finally(() => {
      clearTimeout(deadline)
      process.exit(0)
    })
}
