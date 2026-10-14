import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applyEdits, modify } from 'jsonc-parser'
import writeFileAtomic from 'write-file-atomic'
import { isVscodeSettingsDocument } from '../shared/vscode-utils'

// Prepare remote settings before startup so VS Code owns persistence from the first connection.
export async function prepareVscodeRemoteSettings(
  directory: string,
): Promise<void> {
  const path = join(directory, 'data', 'Machine', 'settings.json')
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    content = '{}\n'
  }
  if (!isVscodeSettingsDocument(content))
    throw new Error(`Invalid VS Code remote settings: ${path}`)
  const next = applyEdits(
    content,
    modify(content, ['terminal.integrated.enablePersistentSessions'], true, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )
  if (next === content) return
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, next, { encoding: 'utf8' })
}
