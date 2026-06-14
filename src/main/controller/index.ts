import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { logger } from '../../server/logger'

const log = logger.child({ process: 'main' })

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
    resizable: false,
    title: 'ADE',
    webPreferences: webPreferences(),
  })

  // The launcher is the app's root window; closing it quits the app even if the
  // worktrees window is still open.
  window.on('closed', () => {
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
    title: 'Worktrees',
    webPreferences: webPreferences(),
  })

  window.on('closed', () => {
    worktreesWindow = null
  })

  worktreesWindow = window
  loadRenderer(window, 'worktrees')
}
