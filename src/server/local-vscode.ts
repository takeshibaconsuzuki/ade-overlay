import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import writeFileAtomic from 'write-file-atomic'
import type { ServerConfig } from './config.ts'
import type { LocalCode } from './code-cli.ts'

export interface ImportedProfile {
  name: string
  contents: string
}

export async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// VS Code initializes keybindings only for a new browser profile. Settings are
// now synchronized as whole files, independently of profile initialization.
export async function importLocalVSCode(
  config: ServerConfig['editor'],
  code: LocalCode | undefined,
  signal?: AbortSignal,
): Promise<{ profile?: ImportedProfile }> {
  const userData = config?.localUserDataDir ?? code?.userDataDir
  if (!userData) return {}
  const keybindings = await optionalText(
    join(userData, 'User', 'keybindings.json'),
  )
  signal?.throwIfAborted()
  return {
    profile: {
      name: '',
      contents: JSON.stringify({
        name: 'Local VS Code',
        // Create the empty file through VS Code before its filesystem caches
        // initialize. Otherwise a first IndexedDB sync can leave stat() reporting
        // a missing file, despite receiving the change notification.
        settings: JSON.stringify({ settings: '{}\n' }),
        ...(keybindings
          ? { keybindings: JSON.stringify({ keybindings }) }
          : {}),
      }),
    },
  }
}

export async function prepareEditorSettings(
  userData: string,
  dataDir: string,
): Promise<void> {
  await migrateEditorSettings(userData, dataDir)
  // Remote settings belong to this ADE server, outside User settings sync.
  // Reconnecting a new desktop client must retain the server's live terminals.
  const directory = join(userData, 'Machine')
  const path = join(directory, 'settings.json')
  const before = (await optionalText(path)) ?? '{}\n'
  const errors: ParseError[] = []
  const current = parse(before, errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  })
  if (
    errors.length ||
    (current !== undefined &&
      (!current || typeof current !== 'object' || Array.isArray(current)))
  )
    throw new Error(`Cannot update invalid VS Code Remote settings: ${path}`)
  const key = 'terminal.integrated.enablePersistentSessions'
  if (current?.[key] === true) return
  const after = applyEdits(
    before,
    modify(before, [key], true, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFileAtomic(path, after, { mode: 0o600 })
}

async function migrateEditorSettings(
  userData: string,
  dataDir: string,
): Promise<void> {
  await mkdir(join(userData, 'User'), { recursive: true, mode: 0o700 })
  const migrated = join(userData, '.ade-settings-sync-migrated')
  if (await optionalText(migrated)) return
  const previous = await optionalText(join(dataDir, 'local-import.json'))
  if (previous) {
    const imported = JSON.parse(previous).settings as
      | Record<string, unknown>
      | undefined
    if (imported)
      for (const folder of ['User', 'Machine']) {
        const path = join(userData, folder, 'settings.json')
        const before = await optionalText(path)
        if (!before) continue
        const errors: ParseError[] = []
        const current = parse(before, errors, { allowTrailingComma: true })
        if (
          errors.length ||
          !current ||
          typeof current !== 'object' ||
          Array.isArray(current)
        )
          throw new Error(`Cannot migrate invalid VS Code settings: ${path}`)
        let after = before
        for (const [key, value] of Object.entries(imported)) {
          if (
            Object.hasOwn(current, key) &&
            isDeepStrictEqual(current[key], value)
          )
            after = applyEdits(after, modify(after, [key], undefined, {}))
        }
        if (after === before) continue
        const backup = path + '.before-settings-sync'
        try {
          await writeFile(backup, before, { flag: 'wx', mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        await writeFileAtomic(path, after)
      }
  }
  await writeFile(migrated, '1\n', { mode: 0o600 })
}
