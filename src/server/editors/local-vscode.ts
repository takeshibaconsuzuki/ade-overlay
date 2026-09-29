import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import writeFileAtomic from 'write-file-atomic'

export interface ImportedProfile {
  name: string
  contents: string
}

async function optionalText(path: string): Promise<string | undefined> {
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
  userData: string,
  signal?: AbortSignal,
): Promise<ImportedProfile> {
  const keybindings = await optionalText(
    join(userData, 'User', 'keybindings.json'),
  )
  signal?.throwIfAborted()
  return {
    name: '',
    contents: JSON.stringify({
      name: 'Local VS Code',
      // Create the empty file through VS Code before its filesystem caches
      // initialize. Otherwise a first IndexedDB sync can leave stat() reporting
      // a missing file, despite receiving the change notification.
      settings: JSON.stringify({ settings: '{}\n' }),
      ...(keybindings ? { keybindings: JSON.stringify({ keybindings }) } : {}),
    }),
  }
}

export async function prepareEditorSettings(userData: string): Promise<void> {
  // Remote settings belong to this ADE server, outside User settings sync.
  // Reconnecting a new desktop client must retain the server's live terminals.
  // Python activation must not inject commands into provider terminals.
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
  let after = before
  for (const [key, value] of Object.entries({
    'terminal.integrated.enablePersistentSessions': true,
    'python-envs.terminal.autoActivationType': 'off',
  })) {
    if (current?.[key] === value) continue
    after = applyEdits(
      after,
      modify(after, [key], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    )
  }
  if (after === before) return
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFileAtomic(path, after, { mode: 0o600 })
}
