import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createWindow(): void {
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  if (devServerUrl) {
    window.loadURL(devServerUrl)
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
