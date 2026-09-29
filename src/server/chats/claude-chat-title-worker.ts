import { parentPort, workerData } from 'node:worker_threads'
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk'

const titles = new Map<string, string>()
for (const sessionId of workerData as string[]) {
  const info = await getSessionInfo(sessionId).catch(() => undefined)
  const title = info?.summary.trim().slice(0, 512)
  if (title) titles.set(sessionId, title)
}
parentPort!.postMessage(titles)
