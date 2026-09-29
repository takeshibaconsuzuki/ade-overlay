import { readFile } from 'node:fs/promises'

const asset = new URL(
  import.meta.url.endsWith('.ts')
    ? '../../../out/server/assets/settings-sync.js'
    : '../../assets/settings-sync.js',
  import.meta.url,
)

// Read the built browser entry, including rebuilds while the dev server runs.
export function settingsSyncScript(): Promise<string> {
  return readFile(asset, 'utf8')
}
