import { app, dialog, globalShortcut } from 'electron'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const input = JSON.parse(
  readFileSync(process.env.ADE_EDITOR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', input.userData)
// A duplicate must exit before showing errors, claiming shortcuts or opening
// windows, even when its configuration differs from the running instance.
dialog.showErrorBox = () => app.exit(2)
globalShortcut.register = () => app.exit(3)
app.on('browser-window-created', () => app.exit(4))
setTimeout(() => app.exit(5), 5000)
await import(pathToFileURL(input.main).href)
