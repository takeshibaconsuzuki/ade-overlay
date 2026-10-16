import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'

// Installed handlers end with this argument, which identifies them on reinstallation.
// The reporter ignores it.
export const HOOK_MARKER = '--ade-overlay'

const groupSchema = z.looseObject({
  hooks: z.array(
    z.looseObject({
      type: z.string(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
    }),
  ),
})

const documentSchema = z.looseObject({
  hooks: z.record(z.string(), z.array(groupSchema)).optional(),
})

export type HookGroup = z.infer<typeof groupSchema>

// Replaces previously installed handlers in a provider's JSON hook configuration
// with one group per event, preserving all other content. Invalid configuration
// is never overwritten, and unchanged files are not rewritten.
export async function installHooks(
  path: string,
  groups: Readonly<Record<string, HookGroup>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
  })
  try {
    let content = '{}'
    try {
      content = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const document = documentSchema.parse(JSON.parse(content))
    const hooks = (document.hooks ??= {})
    for (const [event, existing] of Object.entries(hooks)) {
      hooks[event] = existing.flatMap((group) => {
        const remaining = group.hooks.filter(
          (hook) =>
            !(
              hook.type === 'command' &&
              (hook.args?.at(-1) === HOOK_MARKER ||
                hook.command?.endsWith(` ${HOOK_MARKER}`))
            ),
        )
        return remaining.length === group.hooks.length
          ? [group]
          : remaining.length
            ? [{ ...group, hooks: remaining }]
            : []
      })
    }
    for (const [event, group] of Object.entries(groups))
      (hooks[event] ??= []).push(group)
    const next = JSON.stringify(document, null, 2) + '\n'
    if (next !== content)
      await writeFileAtomic(path, next, { encoding: 'utf8' })
  } finally {
    await release()
  }
}
