import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import lockfile from 'proper-lockfile'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { chatProviders, type ChatProvider } from './chat-providers.ts'

const hookGroupSchema = z
  .object({ hooks: z.array(z.record(z.string(), z.unknown())) })
  .passthrough()
const hookFileSchema = z
  .object({ hooks: z.record(z.string(), z.array(hookGroupSchema)).optional() })
  .passthrough()
const marker = 'ADE chat activity'

export async function installProviderHooks(
  provider: ChatProvider,
  path: string,
  reporter: string,
  node = process.execPath,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
  })
  try {
    const previous = await readFile(path, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return '{}'
      },
    )
    const document = hookFileSchema.parse(
      JSON.parse(previous.replace(/^\uFEFF/, '')),
    )
    document.hooks ??= {}
    // A stable, owned status marker lets upgrades replace only ADE handlers.
    for (const [event, groups] of Object.entries(document.hooks)) {
      document.hooks[event] = groups.flatMap((group) => {
        if (!group.hooks.some((handler) => handler.statusMessage === marker))
          return [group]
        const hooks = group.hooks.filter(
          (handler) => handler.statusMessage !== marker,
        )
        return hooks.length ? [{ ...group, hooks }] : []
      })
    }
    const args = [node, '--experimental-strip-types', reporter, provider.id]
    for (const event of provider.events) {
      ;(document.hooks[event] ??= []).push({
        hooks: [
          {
            ...provider.hookCommand(args),
            statusMessage: marker,
          },
        ],
      })
    }
    const next = JSON.stringify(document, null, 2) + '\n'
    if (next === previous) return false
    await writeFileAtomic(path, next, { mode: 0o600 })
    return true
  } finally {
    await release()
  }
}

export async function installChatHooks(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const reporter = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './chat-hook.ts' : './chat-hook.js',
      import.meta.url,
    ),
  )
  for (const provider of chatProviders)
    await installProviderHooks(provider, provider.hookFile(env), reporter)
}
