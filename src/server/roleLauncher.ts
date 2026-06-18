import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AdeAppRole } from '../api/server/appFocus'

/**
 * Display name of each spawned role's helper `.app` bundle. Must match the
 * bundles built by scripts/package-mac.mjs.
 */
const ROLE_BUNDLE_NAME: Record<AdeAppRole, string> = {
  editor: 'ADE Editor',
  chat: 'ADE Chat',
}

/**
 * Resolves the executable that launches a spawned role.
 *
 * Packaged macOS builds ship a per-role helper `.app` bundle, each with its own
 * `CFBundleIdentifier` and icon, so macOS treats it as a separate app with its
 * own dock tile (see src/DESIGN.md — the roles are deliberately separate apps).
 * Launching the helper's executable gives the process that distinct identity
 * instead of inheriting the controller's bundle and overtaking its dock tile.
 *
 * Falls back to the shared Electron binary in development and on platforms
 * without helper bundles, where the roles share one bundle.
 */
export function roleExecutablePath(role: AdeAppRole): string {
  if (process.platform === 'darwin') {
    // process.execPath -> .../<App>.app/Contents/MacOS/<exe>; the helper sits at
    // .../<App>.app/Contents/Frameworks/<name>.app/Contents/MacOS/<name>.
    const helper = join(
      dirname(process.execPath),
      '..',
      'Frameworks',
      `${ROLE_BUNDLE_NAME[role]}.app`,
      'Contents',
      'MacOS',
      ROLE_BUNDLE_NAME[role],
    )
    if (existsSync(helper)) {
      return helper
    }
  }
  return process.execPath
}

/**
 * Re-derives this process's launch args with the role forced to `role`, so the
 * spawned Electron process boots that role's window.
 */
export function roleLaunchArgs(role: AdeAppRole): string[] {
  const args = process.argv.slice(1)
  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--role') {
      index += 1
      continue
    }
    if (arg.startsWith('--role=')) {
      continue
    }
    filtered.push(arg)
  }
  filtered.push('--role', role)
  return filtered
}
