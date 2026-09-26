import { app, BaseWindow, WebContentsView, webContents } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const input = JSON.parse(
  readFileSync(process.env.ADE_EDITOR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', input.userData)
// Exercise real permission decisions without recording from physical devices.
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.on('window-all-closed', () => {})
let stage = 'startup'
const deadline = setTimeout(() => {
  writeFileSync(input.result, JSON.stringify({ ok: false, stage }))
  app.exit(1)
}, 20_000)

// Never return, log, or replace the user's clipboard contents.
const paste = `(async () => {
  try { await navigator.clipboard.readText(); return 'allowed'; }
  catch (error) { return error.name; }
})()`
const capture = (constraints) => `(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)});
    const kinds = stream.getTracks().map(track => track.kind);
    stream.getTracks().forEach(track => track.stop());
    return kinds;
  } catch (error) { return error.name; }
})()`

async function run() {
  await app.whenReady()
  const { EditorWindow } = await import(pathToFileURL(input.editorModule).href)
  const manager = new EditorWindow()
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>Editor permissions test</title>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const path = `/editors/${'a'.repeat(64)}/`
  let unrelated
  try {
    await manager.open(
      origin.replace('http:', 'ws:') + '/companion',
      {
        id: 'a'.repeat(64),
        path,
        accessToken: 'test-token',
      },
      { project: 'project', path: 'worktree' },
    )
    const editor = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === origin + path)
    assert.ok(editor)
    stage = 'clipboard reads require a user gesture'
    assert.equal(await editor.executeJavaScript(paste), 'NotAllowedError')
    stage = 'user-initiated clipboard read'
    assert.equal(await editor.executeJavaScript(paste, true), 'allowed')
    stage = 'microphone is allowed, camera is denied'
    assert.deepEqual(
      await editor.executeJavaScript(capture({ audio: true }), true),
      ['audio'],
    )
    assert.equal(
      await editor.executeJavaScript(capture({ video: true }), true),
      'NotAllowedError',
    )
    assert.equal(
      await editor.executeJavaScript(
        capture({ audio: true, video: true }),
        true,
      ),
      'NotAllowedError',
    )

    stage = 'extension frames can use delegated clipboard and microphone access'
    const frameUrl = `${origin.replace('127.0.0.1', 'localhost')}/extension/`
    await editor.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.allow = 'clipboard-read; clipboard-write; microphone';
      frame.src = ${JSON.stringify(frameUrl)};
      frame.onload = resolve;
      document.body.append(frame);
    })`)
    const frame = editor.mainFrame.framesInSubtree.find(
      (frame) => frame.url === frameUrl,
    )
    assert.ok(frame)
    await editor.executeJavaScript("document.querySelector('iframe').focus()")
    assert.equal(await frame.executeJavaScript(paste, true), 'allowed')
    assert.deepEqual(
      await frame.executeJavaScript(capture({ audio: true }), true),
      ['audio'],
    )

    stage =
      'unregistered views sharing the browser session cannot acquire permissions'
    unrelated = new WebContentsView({
      webPreferences: { session: editor.session, sandbox: true },
    })
    await unrelated.webContents.loadURL(origin + path)
    assert.equal(
      await unrelated.webContents.executeJavaScript(
        capture({ audio: true }),
        true,
      ),
      'NotAllowedError',
    )
    assert.equal(
      await unrelated.webContents.executeJavaScript(paste, true),
      'NotAllowedError',
    )

    stage = 'navigation outside the registered editor revokes permissions'
    await editor.loadURL(origin + '/untrusted/')
    assert.equal(
      await editor.executeJavaScript(capture({ audio: true }), true),
      'NotAllowedError',
    )
    assert.equal(await editor.executeJavaScript(paste, true), 'NotAllowedError')
  } finally {
    unrelated?.webContents.close()
    manager.close()
    for (const window of BaseWindow.getAllWindows()) window.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  clearTimeout(deadline)
  writeFileSync(input.result, JSON.stringify({ ok: true }))
  app.exit(0)
}
run().catch((error) => {
  writeFileSync(
    input.result,
    JSON.stringify({ ok: false, stage, error: error.stack }),
  )
  app.exit(1)
})
