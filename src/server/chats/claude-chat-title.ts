import { isAbsolute } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ChatTitleRequests, ChatTitles } from './chat-providers.ts'

export async function readClaudeTitles(
  requests: ChatTitleRequests,
): Promise<ChatTitles> {
  const titles: ChatTitles = new Map()
  for (const [root, sessions] of requests) {
    if (!isAbsolute(root) || !sessions.size) continue
    // The SDK reads CLAUDE_CONFIG_DIR from process.env. A worker gives each
    // provider home its own environment without changing the companion's.
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith('.ts')
          ? './claude-chat-title-worker.ts'
          : './claude-chat-title-worker.js',
        import.meta.url,
      ),
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: root },
        workerData: [...sessions],
      },
    )
    try {
      const found = await new Promise<Map<string, string>>(
        (resolve, reject) => {
          worker.once('message', resolve)
          worker.once('error', reject)
          worker.once('exit', () => resolve(new Map()))
        },
      )
      titles.set(root, found)
    } catch {
      // A failed metadata source must not discard titles from other homes.
    } finally {
      await worker.terminate()
    }
  }
  return titles
}
