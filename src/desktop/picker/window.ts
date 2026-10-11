import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { APP_DISPLAY_NAME } from '../../shared/constants'

export function createWorktreePickerWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: APP_DISPLAY_NAME,
    width: 900,
    height: 600,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/picker.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  window.on('blur', () => {
    window.hide()
  })
  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  if (devServerUrl) {
    window.loadURL(new URL('picker/renderer/index.html', devServerUrl).href)
  } else {
    window.loadFile(
      join(import.meta.dirname, '../renderer/picker/renderer/index.html'),
    )
  }
  return window
}
