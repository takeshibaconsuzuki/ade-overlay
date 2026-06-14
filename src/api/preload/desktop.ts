/**
 * Privileged desktop API exposed by the Electron preload bridge.
 *
 * This is a node-free contract shared by preload and renderer code. The preload
 * implements it; the renderer uses it through the ambient `window.desktop`
 * declaration.
 */
export interface DesktopApi {
  /** Opens a native directory picker; resolves to the chosen path or null. */
  selectRepository(): Promise<string | null>
  /** Opens the worktrees window (focusing it if already open). */
  openWorktrees(): Promise<void>
}

export const DESKTOP_API_GLOBAL = 'desktop'
