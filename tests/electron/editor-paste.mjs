import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
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
    const reservations = new Map()
    const documents = []
    let focusable = true
    const focused = []
    const dispose = installEditorPaste(
      contents,
      () => active,
      (url) => url?.protocol === 'file:',
      () => {
        if (!focusable) return
        window.focus()
        contents.focus()
      },
      async (documentId) => {
        calls++
        documents.push(documentId)
        focused.push(await contents.executeJavaScript('document.hasFocus()'))
        if (target === null) return null
        const id = randomUUID()
        reservations.set(id, { documentId, target })
        return id
      },
      async (documentId, id, items) => {
        const reservation = reservations.get(id)
        if (!reservation || reservation.documentId !== documentId)
          throw new Error('The paste reservation is invalid or expired.')
        reservations.delete(id)
        logs.push([reservation.target, items])
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
    assert.equal(
      documents[0],
      documents[1],
      'document scope stays stable between pastes',
    )
    await contents.executeJavaScript('adePaste.reservePaste()', true)
    assert.notEqual(
      documents.at(-1),
      documents[0],
      'navigation changes the document scope supplied to the server',
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
    // A trusted drop proves the gesture without DOM activation. A drag from
    // another application leaves the window in the background, so main focuses
    // the page before the extension is asked for its active terminal.
    target = 'chat-drop'
    window.showInactive()
    assert.equal(
      await contents.executeJavaScript(`(() => {
        document.addEventListener('dragover', (event) => event.preventDefault());
        document.addEventListener('drop', (event) => {
          event.preventDefault();
          globalThis.dropped = adePaste.reservePaste().then((id) => ({ id }), (error) => ({ error: String(error) }));
        });
        return document.hasFocus();
      })()`),
      false,
    )
    contents.debugger.attach()
    const drop = async () => {
      const data = {
        items: [],
        files: [join(root, 'index.html')],
        dragOperationsMask: 1,
      }
      for (const type of ['dragEnter', 'dragOver', 'drop'])
        await contents.debugger.sendCommand('Input.dispatchDragEvent', {
          type,
          x: 20,
          y: 20,
          data,
        })
      return contents.executeJavaScript('dropped')
    }
    focusable = false
    const before = calls
    assert.match((await drop()).error, /could not be focused/)
    assert.equal(calls, before, 'an unfocused drop never queries a target')
    focusable = true
    assert.equal(reservations.get((await drop()).id)?.target, 'chat-drop')
    assert.equal(focused.at(-1), true, 'the page is focused before the query')
    contents.debugger.detach()
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
