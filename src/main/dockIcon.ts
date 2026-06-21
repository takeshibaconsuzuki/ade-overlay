import { join } from 'node:path'
import { app, nativeImage } from 'electron'
import { type AdeAppRole } from '../api/server/appFocus'
import { logger } from '../server/logger'

const log = logger.child({ process: 'main' })

/**
 * The roles that own a dock entry. `controller` is the default role (the
 * launcher); `editor` and `chat` are the spawned sibling apps. Each maps to a
 * PNG copied into `out/main/icons` at build time (see electron.vite.config).
 */
export type DockRole = 'controller' | AdeAppRole

/**
 * Gives the current role its own macOS dock icon, so the launcher, editor, and
 * chat apps are distinguishable in the dock and app switcher.
 *
 * Packaged builds launch editor and chat from their own helper `.app` bundles,
 * so each already carries its bundle icon; this runtime call still applies the
 * icon in development, where all roles share the single Electron bundle. No-op
 * off macOS, where `app.dock` is undefined.
 */
export function setRoleDockIcon(role: DockRole): void {
  if (process.platform !== 'darwin' || !app.dock) {
    return
  }

  const iconPath = join(import.meta.dirname, 'icons', `${role}.png`)
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    log.warn({ role, iconPath }, 'role dock icon missing; keeping default')
    return
  }

  app.dock.setIcon(icon)
}
