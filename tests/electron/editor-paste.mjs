import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
app.setPath('userData', join(root, 'browser'))
async function run() {
  try {
    await app.whenReady()
    const { installEditorPaste } = await import(
      pathToFileURL(join(root, 'editor-paste.mjs'))
    )
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(root, 'editor.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    const contents = window.webContents
    let active = true
    let target = 'chat-first'
    let calls = 0
    const logs = []
    const dispose = installEditorPaste(
      contents,
      () => active,
      (url) => url?.protocol === 'file:',
      async () => {
        calls++
        return target
      },
      async (terminalId, items) => {
        logs.push([terminalId, items])
      },
    )
    await window.loadFile(join(root, 'index.html'))
    assert.deepEqual(
      await contents.executeJavaScript('Object.keys(window.adePaste).sort()'),
      ['paste', 'reservePaste'],
    )
    assert.equal(
      await contents.executeJavaScript('typeof require'),
      'undefined',
    )
    // Fresh document has no activation; the bridge cannot query the extension.
    await assert.rejects(
      contents.executeJavaScript('adePaste.reservePaste(true)'),
      /user gesture/,
    )
    assert.equal(calls, 0)
    const id = await contents.executeJavaScript('adePaste.reservePaste()', true)
    target = 'chat-second'
    await contents.executeJavaScript(
      `adePaste.paste(${JSON.stringify(id)}, [{ type: 'text', data: 'before' }, { type: 'image', data: new Uint8Array([1, 2]) }, { type: 'text', data: 'after' }])`,
    )
    assert.equal(
      logs[0][0],
      'chat-first',
      'submission keeps the reserved target after focus changes',
    )
    assert.deepEqual(logs[0][1], [
      { type: 'text', data: 'before' },
      { type: 'image', data: new Uint8Array([1, 2]) },
      { type: 'text', data: 'after' },
    ])
    await assert.rejects(
      contents.executeJavaScript(`adePaste.paste(${JSON.stringify(id)}, [])`),
      /invalid or expired/,
    )
    await assert.rejects(
      contents.executeJavaScript(`adePaste.paste('unknown', [])`),
      /invalid or expired/,
    )
    const bad = await contents.executeJavaScript(
      'adePaste.reservePaste()',
      true,
    )
    await assert.rejects(
      contents.executeJavaScript(
        `adePaste.paste(${JSON.stringify(bad)}, [{ type: 'text', data: new Uint8Array([1]) }])`,
      ),
    )
    assert.equal(logs.length, 1)
    const stale = await contents.executeJavaScript(
      'adePaste.reservePaste()',
      true,
    )
    await window.loadFile(join(root, 'index.html'))
    await assert.rejects(
      contents.executeJavaScript(
        `adePaste.paste(${JSON.stringify(stale)}, [])`,
      ),
      /invalid or expired/,
    )
    active = false
    await assert.rejects(
      contents.executeJavaScript('adePaste.reservePaste()', true),
      /Untrusted paste caller/,
    )
    active = true
    target = null
    assert.equal(
      await contents.executeJavaScript('adePaste.reservePaste()', true),
      null,
    )
    dispose()
    window.destroy()
    writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true }))
    app.exit(0)
  } catch (error) {
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify({ error: error.stack }),
    )
    app.exit(1)
  }
}
void run()
