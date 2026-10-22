import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// node-pty ships the macOS prebuilt helper without its executable permission.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('node-pty/package.json'))
  const helper = join(
    root,
    'prebuilds',
    `darwin-${process.arch}`,
    'spawn-helper',
  )
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
