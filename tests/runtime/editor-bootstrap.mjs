import { app, BaseWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const input = JSON.parse(
  readFileSync(process.env.ADE_EDITOR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', input.userData)
BaseWindow.prototype.show = function () {}
app.on('window-all-closed', () => {})
let stage = 'starting'
const timeout = setTimeout(() => finish({ ok: false, stage }), 60_000)
function finish(outcome) {
  clearTimeout(timeout)
  writeFileSync(input.result, JSON.stringify(outcome))
  app.exit(outcome.ok ? 0 : 1)
}
const read = (name) => {
  const path = join(input.project, name)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}
async function until(check) {
  const end = Date.now() + 25_000
  while (Date.now() < end) {
    const error = join(input.project, 'bootstrap-error.txt')
    if (existsSync(error)) throw new Error(readFileSync(error, 'utf8'))
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out: ' + stage)
}
async function run() {
  try {
    await app.whenReady()
    const { EditorWindow } = await import(
      pathToFileURL(input.editorModule).href
    )
    const manager = new EditorWindow(input.url)
    stage = 'extension-host credential and native terminal/task isolation'
    const page = await manager.open(input.editor, {
      project: input.project,
      path: input.project,
    })
    assert.equal(await page.chatActivation(), null)
    await until(
      () =>
        read('bootstrap-extension.json') &&
        read('native-environment.json') &&
        read('task-environment.json'),
    )
    for (const name of ['native-environment.json', 'task-environment.json']) {
      assert.deepEqual(read(name), { control: false, activity: true })
    }
    const before = read('bootstrap-extension.json')
    const view = webContents
      .getAllWebContents()
      .find((contents) =>
        contents.getURL().includes(`/editors/${input.editor.id}/`),
      )
    // A fresh document exposes the current extension activation as its baseline.
    const activation = await view.executeJavaScript(`fetch(location.href)
      .then(response => response.text())
      .then(html => new DOMParser().parseFromString(html, 'text/html')
        .querySelector('meta[name="ade-chat-activation-after"]')?.content)`)
    assert.ok(activation)
    stage =
      'reload establishes a new document baseline and extension activation'
    const loaded = new Promise((resolve) => view.once('dom-ready', resolve))
    writeFileSync(join(input.project, 'reload-request'), '')
    await loaded
    assert.equal(await page.chatActivation(), activation)
    await until(() => read('bootstrap-extension.json')?.pid !== before.pid)
    assert.notEqual(read('bootstrap-extension.json').pid, before.pid)
    await until(() => read('restored-terminal.json'))
    assert.deepEqual(
      read('restored-terminal.json'),
      read('terminal-identity.json'),
    )
    manager.close()
    finish({ ok: true })
  } catch (error) {
    finish({ ok: false, stage, error: String(error.stack || error) })
  }
}
void run()
