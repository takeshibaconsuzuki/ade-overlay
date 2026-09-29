import { app, BaseWindow, shell, webContents } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const input = JSON.parse(
  readFileSync(process.env.ADE_EDITOR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', input.userData)
BaseWindow.prototype.show = function () {}
app.on('window-all-closed', () => {})
let stage = 'startup'
const deadline = setTimeout(() => {
  writeFileSync(input.result, JSON.stringify({ ok: false, stage }))
  app.exit(1)
}, 20_000)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (await check()) return
    await delay(20)
  }
  throw new Error(`Timed out: ${stage}`)
}

async function run() {
  await app.whenReady()
  // Observe the OS handoff without launching the developer's browser.
  const opened = []
  let failOpen = false
  shell.openExternal = async (...args) => {
    opened.push(args)
    if (failOpen) throw new Error('No browser available')
  }
  const { EditorWindow } = await import(pathToFileURL(input.editorModule).href)
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(
      '<!doctype html><title>Editor link test</title><body>Editor</body>',
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const manager = new EditorWindow(
    origin.replace('http:', 'ws:') + '/companion',
  )
  const path = `/editors/${'a'.repeat(64)}/`
  try {
    const page = await manager.open(
      { id: 'a'.repeat(64), accessToken: 'test-token' },
      { project: 'project', path: 'worktree' },
    )
    const editor = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === origin + path)
    assert.ok(editor)
    const count = webContents.getAllWebContents().length
    const click = (url, target = '_blank') =>
      editor.executeJavaScript(
        `{
      const link = document.createElement('a');
      link.href = ${JSON.stringify(url)};
      link.target = ${JSON.stringify(target)};
      document.body.append(link);
      link.click();
      link.remove();
    }`,
        true,
      )

    stage = 'new-window web links are handed to the desktop shell'
    for (const url of [
      'https://example.com/docs?q=hello#section',
      `${origin}/app`,
    ]) {
      const before = opened.length
      await click(url)
      await until(() => opened.length === before + 1)
      assert.deepEqual(opened.at(-1), [url])
    }
    assert.ok(!requests.includes('/app'))

    stage = 'same-window links preserve the ready editor'
    await click('https://example.com/same-window', '_self')
    await until(() => opened.length === 3)
    assert.deepEqual(opened.at(-1), ['https://example.com/same-window'])
    assert.equal(editor.getURL(), origin + path)
    assert.equal(page.state, 'ready')

    stage = 'unsafe schemes and editor popups never reach the shell'
    for (const url of [
      'file:///tmp/ade-link-test',
      'data:text/html,blocked',
      'vscode://publisher.extension/action',
      'mailto:test@example.com',
      'about:blank',
      origin + path,
    ]) {
      await click(url)
    }
    await delay(100)
    assert.equal(opened.length, 3)
    assert.equal(webContents.getAllWebContents().length, count)

    stage = 'extension frame popups use the same browser handoff'
    const frameUrl = `${origin}/extension/`
    await editor.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.src = ${JSON.stringify(frameUrl)};
      frame.onload = resolve;
      document.body.append(frame);
    })`)
    const frame = editor.mainFrame.framesInSubtree.find(
      (frame) => frame.url === frameUrl,
    )
    assert.ok(frame)
    assert.equal(opened.length, 3, 'ordinary frame navigation stays embedded')
    await frame.executeJavaScript(
      "window.open('https://example.com/extension'); void 0",
      true,
    )
    await until(() => opened.length === 4)
    assert.deepEqual(opened.at(-1), ['https://example.com/extension'])

    stage = 'a failed browser launch leaves the editor usable'
    failOpen = true
    await click('https://example.com/failure')
    await until(() => opened.length === 5)
    await delay(50)
    assert.equal(page.state, 'ready')
    assert.equal(editor.getURL(), origin + path)

    stage = 'internal editor navigation remains in the retained view'
    await click(`${origin}${path}?folder=next`, '_self')
    await until(() => editor.getURL() === `${origin}${path}?folder=next`)
    await page.whenReady()
    assert.equal(page.state, 'ready')
    assert.equal(opened.length, 5)
    assert.equal(webContents.getAllWebContents().length, count)
  } finally {
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
