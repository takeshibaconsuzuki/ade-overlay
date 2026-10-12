import { createHash } from 'node:crypto'
import { pathKey } from './path-key'

export function vscodeBasePath(path: string): string {
  const key = pathKey(path)
  return `/vscode/${createHash('sha256').update(key).digest('hex')}`
}
