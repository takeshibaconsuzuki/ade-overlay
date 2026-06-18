import { app, BrowserWindow, globalShortcut } from 'electron'
import { logger } from '../../server/logger'
import { loadRenderer, webPreferences } from '../browser'

const log = logger.child({ process: 'main' })

/** Global shortcut that flips the launcher between active and dormant. */
const TOGGLE_ACCELERATOR = 'CommandOrControl+Shift+Space'

/**
 * Window background painted before the renderer's first frame. Matches the dark
 * theme's base surface (Radix slate-1 in dark mode, also the editor window's
 * background) so the window never flashes white while the renderer loads.
 */
const WINDOW_BACKGROUND = '#111113'

/** Window opacity used while the launcher is dormant. */
const DORMANT_OPACITY = 0.4

/**
 * The launcher's two interaction modes:
 * - `active`: fully opaque and clickable.
 * - `dormant`: translucent, with clicks passing through to whatever is behind.
 */
type LauncherState = 'active' | 'dormant'

let launcherWindow: BrowserWindow | null = null
let launcherState: LauncherState = 'active'

/**
 * Applies a launcher state to the window. `setIgnoreMouseEvents` only affects
 * this window, so the rest of the desktop keeps receiving mouse events normally
 * in either state.
 */
function applyLauncherState(window: BrowserWindow, state: LauncherState): void {
  if (state === 'dormant') {
    window.setOpacity(DORMANT_OPACITY)
    window.setIgnoreMouseEvents(true, { forward: true })
    window.showInactive()
  } else {
    window.setOpacity(1)
    window.setIgnoreMouseEvents(false)
    // Bring the launcher forward and give it keyboard focus so it is ready to
    // use the moment it becomes active.
    window.show()
    window.focus()
  }
}

/** Moves the launcher to an explicit state, doing nothing if already there. */
function setLauncherState(state: LauncherState): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) {
    return
  }
  if (launcherState === state) {
    return
  }
  launcherState = state
  applyLauncherState(launcherWindow, state)
  log.info({ state }, 'launcher state changed')
}

/** Toggles the launcher between active and dormant. */
function toggleLauncherState(): void {
  setLauncherState(launcherState === 'active' ? 'dormant' : 'active')
}

/**
 * Creates the small launcher window shown on startup. It hosts the button that
 * opens the worktrees window.
 */
export function createWindow(): void {
  const window = new BrowserWindow({
    width: 360,
    height: 440,
    resizable: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    // Drop the native titlebar on every platform; the renderer draws its own
    // titlebar (drag region + close button) so the chrome looks identical
    // everywhere.
    frame: false,
    webPreferences: webPreferences(),
  })

  // Keep the launcher above everything, including other always-on-top windows
  // and full-screen apps, and make it follow the user across every space.
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  launcherWindow = window
  // Start dormant
  launcherState = 'dormant'
  applyLauncherState(window, launcherState)
  if (!globalShortcut.register(TOGGLE_ACCELERATOR, toggleLauncherState)) {
    log.warn(
      { accelerator: TOGGLE_ACCELERATOR },
      'failed to register launcher toggle shortcut',
    )
  }

  // Losing focus drops the launcher to dormant so it gets out of the way; the
  // global shortcut (or clicking once it is active again) brings it back.
  window.on('blur', () => setLauncherState('dormant'))

  // The launcher is the app's root window; closing it quits the app even if the
  // worktrees window is still open.
  window.on('closed', () => {
    globalShortcut.unregister(TOGGLE_ACCELERATOR)
    launcherWindow = null
    log.info('launcher window closed')
    app.quit()
  })

  loadRenderer(window, 'launcher')
}

let worktreesWindow: BrowserWindow | null = null

/**
 * Opens the worktrees window, focusing the existing one if it is already open.
 */
export function openWorktreesWindow(): void {
  if (worktreesWindow && !worktreesWindow.isDestroyed()) {
    worktreesWindow.show()
    worktreesWindow.focus()
    return
  }

  const window = new BrowserWindow({
    width: 900,
    height: 600,
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: webPreferences(),
  })

  window.on('blur', () => {
    window.close()
  })

  window.on('closed', () => {
    worktreesWindow = null
  })

  worktreesWindow = window
  loadRenderer(window, 'worktrees')
}
