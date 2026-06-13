import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export async function canonicalizePath(path: string): Promise<string> {
  return realpath(normalizePath(path))
}

export function normalizePath(path: string): string {
  if (path === '~') {
    return homedir()
  }

  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2))
  }

  return resolve(path)
}
