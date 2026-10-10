import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export function vscodeBasePath(path: string): string {
  const absolute = resolve(path)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  return `/vscode/${createHash('sha256').update(key).digest('hex')}`
}
