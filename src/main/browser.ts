import { join } from 'node:path'
import { type BrowserWindow } from 'electron'

/**
 * Loads the shared renderer single-page app into a window, selecting which view
 * to render via the URL hash. Dev and production load paths differ: the dev
 * server is loaded by URL, the build by file.
 */
export function loadRenderer(window: BrowserWindow, hash: string): void {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  if (devServerUrl) {
    window.loadURL(`${devServerUrl}#${hash}`)
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'), {
      hash,
    })
  }
}

export function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(import.meta.dirname, '../preload/index.mjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  }
}
