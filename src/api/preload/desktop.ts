/**
 * Privileged desktop API exposed by the Electron preload bridge.
 *
 * This is a node-free contract shared by preload and renderer code. The preload
 * implements it; the renderer uses it through the ambient `window.desktop`
 * declaration.
 */
export type ChooseFileKind = 'd' | 'f'

export type ChooseFilesOptions = {
  title: string
  allowed: ChooseFileKind[]
}

export interface DesktopApi {
  /** Opens a native file picker; resolves to the chosen paths. */
  chooseFiles(options: ChooseFilesOptions): Promise<string[]>
  /** Opens the worktrees window (focusing it if already open). */
  openWorktreesWindow(): Promise<void>
  /** Drops the launcher back to its dormant, non-interactive state. */
  setLauncherDormant(): Promise<void>
  /** Closes the window that invokes this (used by the custom titlebar). */
  closeWindow(): Promise<void>
}

export const DESKTOP_API_GLOBAL = 'desktop'
