import { app, BrowserWindow, globalShortcut } from 'electron'
import { join } from 'node:path'
import { logger } from '../../server/logger'

const log = logger.child({ process: 'main' })

/** Global shortcut that flips the launcher between active and dormant. */
const TOGGLE_ACCELERATOR = 'CommandOrControl+Shift+Space'

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
 * Loads the controller renderer (a single-page app) into a window, selecting
 * which view to render via the URL hash. Dev and production load paths differ:
 * the dev server is loaded by URL, the build by file.
 */
function loadRenderer(window: BrowserWindow, hash: string): void {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  if (devServerUrl) {
    window.loadURL(`${devServerUrl}#${hash}`)
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'), {
      hash,
    })
  }
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(import.meta.dirname, '../preload/index.mjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  }
}

/**
 * Creates the small launcher window shown on startup. It hosts the button that
 * opens the worktrees window.
 */
export function createWindow(): void {
  const window = new BrowserWindow({
    width: 280,
    height: 160,
    minWidth: 220,
    minHeight: 140,
    resizable: true,
    alwaysOnTop: true,
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

  // Start active, and let CommandOrControl+Shift+Space flip the state from
  // anywhere — even while dormant and click-through, since it is a global
  // shortcut rather than a window-level one.
  launcherWindow = window
  launcherState = 'active'
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
