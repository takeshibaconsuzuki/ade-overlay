import { app, BaseWindow, BrowserWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'

const input = JSON.parse(
  readFileSync(process.env.ADE_EDITOR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', input.userData)
BaseWindow.prototype.show = function () {}
app.on('browser-window-created', (_event, window) => window.hide())
let stage = 'starting'
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
  throw new Error('Timed out: ' + stage)
}
const tree = (path) => ({
  project: 'project',
  path,
  branch: path,
  head: '',
  main: path === 'a',
  locked: false,
  prunable: false,
  editor: 'running',
})
let snapshot = {
  revision: 1,
  projects: ['project'],
  worktrees: [tree('a'), tree('b')],
}
let heldList
let holdLists = false
let connections = 0
let client
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end('<!doctype html><body>Editor reconnect test</body>')
})
const sockets = new WebSocketServer({ server, path: '/companion' })
sockets.on('connection', (socket) => {
  client = socket
  connections++
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1 }))
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (message.type === 'worktrees:list') {
      const reply = (value) =>
        socket.send(
          JSON.stringify({
            type: 'worktrees',
            id: message.id,
            snapshot: value,
          }),
        )
      if (holdLists) heldList = reply
      else reply(snapshot)
    } else if (message.type === 'editor:open') {
      const id = message.input.path.repeat(64)
      socket.send(
        JSON.stringify({
          type: 'editor',
          id: message.id,
          session: { id, path: `/editors/${id}/`, accessToken: 'c'.repeat(64) },
        }),
      )
    }
  })
})
async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  process.env.ELECTRON_RENDERER_URL = origin
  process.env.ADE_COMPANION_URL = origin.replace('http:', 'ws:') + '/companion'
  process.env.ADE_COMPANION_TOKEN = ''
  await import(pathToFileURL(input.main).href)
  await until(() => BrowserWindow.getAllWindows().length === 1)
  const picker = BrowserWindow.getAllWindows()[0].webContents
  await until(() =>
    picker.executeJavaScript(
      "window.companion?.getStatus().then(status => status.state === 'connected')",
    ),
  )
  await picker.executeJavaScript('window.companion.listWorktrees()')
  const open = (path) =>
    picker.executeJavaScript(
      `window.companion.openEditor(${JSON.stringify({ project: 'project', path })})`,
    )
  const view = (path) =>
    webContents
      .getAllWebContents()
      .find(
        (contents) =>
          contents.getURL() === `${origin}/editors/${path.repeat(64)}/`,
      )
  await open('a')
  await open('b')
  const first = view('a')
  const second = view('b')
  assert.ok(first && second)

  stage = 'closing the editor window keeps the picker and its views alive'
  const pickerWindow = BrowserWindow.fromWebContents(picker)
  const editor = BaseWindow.getAllWindows().find(
    (window) => window !== pickerWindow,
  )
  assert.ok(editor)
  editor.close()
  assert.equal(pickerWindow.isDestroyed(), false)
  assert.equal(first.isDestroyed(), false)
  assert.equal(second.isDestroyed(), false)
  await open('b')
  assert.equal(view('b').id, second.id)

  stage = 'ignoring a stale list reply after a newer pushed update'
  holdLists = true
  const pending = picker.executeJavaScript('window.companion.listWorktrees()')
  await until(() => heldList)
  snapshot = { ...snapshot, revision: 2 }
  // WebSocket ordering guarantees the broadcast is handled before the old reply.
  client.send(
    JSON.stringify({ type: 'worktrees:updated', change: 'created', snapshot }),
  )
  heldList({ ...snapshot, revision: 1, worktrees: [tree('a')] })
  await pending
  assert.equal(second.isDestroyed(), false)
  holdLists = false

  stage = 'recovering a deletion missed during disconnection'
  const before = connections
  client.terminate()
  // A restarted companion can also reset its revision counter.
  snapshot = { ...snapshot, revision: 0, worktrees: [tree('a')] }
  await until(() => connections > before)
  await until(() =>
    picker.executeJavaScript(
      "window.companion.getStatus().then(status => status.state === 'connected')",
    ),
  )
  await picker.executeJavaScript('window.companion.listWorktrees()')
  await until(() => second.isDestroyed())
  assert.equal(first.isDestroyed(), false)
  await open('a')
  assert.equal(view('a').id, first.id, 'surviving editor remains loaded')

  stage =
    'closing the picker quits with active and hidden editors despite unload vetoes'
  snapshot = { ...snapshot, revision: 1, worktrees: [tree('a'), tree('b')] }
  await picker.executeJavaScript('window.companion.listWorktrees()')
  await open('b')
  const active = view('b')
  assert.ok(active)
  await first.executeJavaScript('void (window.onbeforeunload = () => false)')
  await active.executeJavaScript('void (window.onbeforeunload = () => false)')
  const closingViews = new Set()
  for (const contents of [first, active]) {
    const close = contents.close.bind(contents)
    contents.close = (options) => {
      assert.notEqual(options?.waitForBeforeUnload, true)
      closingViews.add(contents)
      close(options)
    }
  }
  client.terminate()
  await until(() =>
    picker.executeJavaScript(
      "window.companion.getStatus().then(status => status.state !== 'connected')",
    ),
  )
  const closingAt = performance.now()
  app.once('will-quit', () => {
    try {
      assert.equal(picker.isDestroyed(), true)
      // Detached contents close asynchronously; the parent also checks that
      // this process actually exits after will-quit without waiting for them.
      assert.deepEqual(closingViews, new Set([first, active]))
      assert.equal(BaseWindow.getAllWindows().length, 0)
      assert.ok(
        performance.now() - closingAt < 2000,
        'picker close must quit promptly',
      )
      writeFileSync(input.result, JSON.stringify({ ok: true }))
      clearTimeout(deadline)
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
      server.closeAllConnections()
      server.close()
    } catch (error) {
      writeFileSync(
        input.result,
        JSON.stringify({ ok: false, stage, error: error.stack }),
      )
      app.exit(1)
    }
  })
  pickerWindow.close()
}
run().catch((error) => {
  writeFileSync(
    input.result,
    JSON.stringify({ ok: false, stage, error: error.stack }),
  )
  app.exit(1)
})
