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
const chatReplies = new Map()
const rowErrors = []
let rejectRowError = false
let rejectEditorOpen = false
let holdEditorOpen = false
let heldEditorOpen
let pageStatus = 200
let activationAfter = '12345678-1234-4234-8234-123456789abc'
let heldPage
let holdPage = false
const server = createServer((request, response) => {
  if (holdPage && request.url.includes('/editors/')) {
    heldPage = response
    return
  }
  response.writeHead(pageStatus, { 'Content-Type': 'text/html' })
  response.end(
    `<!doctype html><head><meta name="ade-chat-activation-after" content="${activationAfter}"></head><body>Editor reconnect test</body>`,
  )
})
const sockets = new WebSocketServer({ server, path: '/companion' })
sockets.on('connection', (socket) => {
  client = socket
  connections++
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1 }))
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (message.type === 'chat:view-ready') chatReplies.set(message.id, message)
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
    } else if (message.type === 'worktrees:set-error') {
      rowErrors.push(message.input)
      if (rejectRowError) {
        socket.send(
          JSON.stringify({
            type: 'error',
            id: message.id,
            message: 'Could not save row error',
          }),
        )
        return
      }
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        worktrees: snapshot.worktrees.map((row) =>
          row.path === message.input.path
            ? { ...row, error: message.input.error }
            : row,
        ),
      }
      socket.send(
        JSON.stringify({
          type: 'worktrees:updated',
          change: 'operation',
          snapshot,
        }),
      )
      socket.send(
        JSON.stringify({ type: 'worktrees', id: message.id, snapshot }),
      )
    } else if (message.type === 'editor:open') {
      if (holdEditorOpen) {
        heldEditorOpen = (error) => {
          const id = message.input.path.repeat(64)
          socket.send(
            JSON.stringify(
              error
                ? { type: 'error', id: message.id, message: error }
                : {
                    type: 'editor',
                    id: message.id,
                    session: {
                      id,
                      path: `/editors/${id}/`,
                      accessToken: 'c'.repeat(64),
                    },
                  },
            ),
          )
        }
        return
      }
      if (rejectEditorOpen) {
        socket.send(
          JSON.stringify({
            type: 'error',
            id: message.id,
            message: 'Server startup failed',
          }),
        )
        return
      }
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
  stage =
    'chat navigation selects retained and fresh worktrees through the real desktop handler'
  for (const path of ['a', 'c']) {
    client.send(
      JSON.stringify({
        type: 'chat:activate',
        id: `chat-${path}`,
        input: { project: 'project', path },
      }),
    )
    await until(() => chatReplies.has(`chat-${path}`))
    const reply = chatReplies.get(`chat-${path}`)
    assert.equal(reply.error, undefined)
    assert.equal(reply.activationAfter, activationAfter)
    assert.ok(
      editor.contentView.children.some(
        (child) => child.webContents === view(path),
      ),
    )
  }
  stage = 'repeated chat navigation waits for the same loading document'
  holdPage = true
  const navigate = (id, path) =>
    client.send(
      JSON.stringify({
        type: 'chat:activate',
        id,
        input: { project: 'project', path },
      }),
    )
  navigate('loading-first', 'd')
  await until(() => heldPage)
  navigate('loading-second', 'd')
  await delay(100)
  assert.equal(chatReplies.has('loading-second'), false)
  holdPage = false
  heldPage.writeHead(200, { 'Content-Type': 'text/html' })
  heldPage.end(
    `<!doctype html><head><meta name="ade-chat-activation-after" content="${activationAfter}"></head><body>Ready</body>`,
  )
  await until(() => chatReplies.has('loading-second'))
  assert.equal(
    chatReplies.get('loading-second').activationAfter,
    activationAfter,
  )
  assert.match(chatReplies.get('loading-first').error, /superseded/i)

  stage = 'retained pages preserve the baseline and reloads replace it'
  const originalBaseline = activationAfter
  activationAfter = '22345678-1234-4234-8234-123456789abc'
  navigate('retained', 'd')
  await until(() => chatReplies.has('retained'))
  assert.equal(chatReplies.get('retained').activationAfter, originalBaseline)
  const reloaded = new Promise((resolve) =>
    view('d').once('dom-ready', resolve),
  )
  view('d').reload()
  await reloaded
  navigate('reloaded', 'd')
  await until(() => chatReplies.has('reloaded'))
  assert.equal(chatReplies.get('reloaded').activationAfter, activationAfter)
  await open('b')
  editor.close()
  assert.equal(pickerWindow.isDestroyed(), false)
  assert.equal(first.isDestroyed(), false)
  assert.equal(second.isDestroyed(), false)
  await open('b')
  assert.equal(view('b').id, second.id)

  const finished = (id) =>
    client.send(JSON.stringify({ type: 'chat:finished', id }))
  const flush = () =>
    picker.executeJavaScript('window.companion.listWorktrees()')
  const activeIs = (path) =>
    assert.ok(
      BaseWindow.getAllWindows()
        .find((window) => window !== pickerWindow)
        .contentView.children.some((child) => child.webContents === view(path)),
    )
  stage = 'terminated chat opens ignore late startup success and failure'
  snapshot = { ...snapshot, worktrees: [...snapshot.worktrees, tree('e')] }
  for (const error of [undefined, 'Late startup failure']) {
    heldEditorOpen = undefined
    holdEditorOpen = true
    const id = error ? 'cancel-error' : 'cancel-success'
    navigate(id, 'e')
    await until(() => heldEditorOpen)
    finished(id)
    heldEditorOpen(error)
    holdEditorOpen = false
    await flush()
    activeIs('b')
    assert.equal(view('e'), undefined)
    assert.equal(chatReplies.has(id), false)
    assert.equal(rowErrors.length, 0)
  }

  stage = 'late completion of an older navigation cannot cancel a newer open'
  for (const kind of ['chat', 'picker']) {
    navigate('old-' + kind, 'a')
    await until(() => chatReplies.has('old-' + kind))
    heldEditorOpen = undefined
    holdEditorOpen = true
    const opening = kind === 'picker' ? open('b') : undefined
    if (kind === 'chat') navigate('new-chat', 'b')
    await until(() => heldEditorOpen)
    finished('old-' + kind)
    heldEditorOpen()
    holdEditorOpen = false
    if (opening) await opening
    else await until(() => chatReplies.has('new-chat'))
    activeIs('b')
  }

  stage = 'cancellation during page loading suppresses late row errors'
  snapshot = { ...snapshot, worktrees: [...snapshot.worktrees, tree('f')] }
  heldPage = undefined
  holdPage = true
  navigate('cancel-page', 'f')
  await until(() => heldPage)
  finished('cancel-page')
  await flush()
  holdPage = false
  heldPage.writeHead(502, { 'Content-Type': 'text/html' })
  heldPage.end('Cancelled page failed')
  await until(() => !view('f'))
  assert.equal(rowErrors.length, 0)
  assert.equal(chatReplies.has('cancel-page'), false)
  await open('b')

  stage = 'chat page failures are shared row errors and survive reconnect'
  pageStatus = 503
  navigate('page-failed', 'e')
  await until(() => chatReplies.has('page-failed') && rowErrors.length === 1)
  const pageError = chatReplies.get('page-failed').error
  assert.match(pageError, /503/)
  assert.deepEqual(rowErrors[0], {
    project: 'project',
    path: 'e',
    error: pageError,
  })
  const connectionBeforeError = connections
  client.terminate()
  await until(() => connections > connectionBeforeError)
  await until(() =>
    picker.executeJavaScript(
      "window.companion.getStatus().then(status => status.state === 'connected')",
    ),
  )
  const recovered = await picker.executeJavaScript(
    'window.companion.listWorktrees()',
  )
  assert.equal(
    recovered.worktrees.find((row) => row.path === 'e').error,
    pageError,
  )
  pageStatus = 200
  navigate('retry-page', 'e')
  await until(() => chatReplies.has('retry-page'))
  assert.equal(chatReplies.get('retry-page').error, undefined)
  assert.equal(
    snapshot.worktrees.find((row) => row.path === 'e').error,
    pageError,
  )

  stage = 'a superseded page failure does not persist a row error'
  heldPage = undefined
  holdPage = true
  navigate('stale-failure', 'f')
  await until(() => heldPage)
  holdPage = false
  navigate('newer-success', 'a')
  await until(() => chatReplies.has('newer-success'))
  heldPage.writeHead(502, { 'Content-Type': 'text/html' })
  heldPage.end('Old page failed')
  await until(() => chatReplies.has('stale-failure'))
  assert.equal(rowErrors.length, 1)

  stage = 'server errors do not get duplicated as desktop page failures'
  rejectEditorOpen = true
  navigate('startup-failed', 'f')
  await until(() => chatReplies.has('startup-failed'))
  assert.equal(chatReplies.get('startup-failed').error, 'Server startup failed')
  assert.equal(rowErrors.length, 1)
  rejectEditorOpen = false

  stage = 'failure to save a row error preserves the source error'
  rejectRowError = true
  pageStatus = 503
  navigate('row-save-failed', 'f')
  await until(
    () => chatReplies.has('row-save-failed') && rowErrors.length === 2,
  )
  assert.match(chatReplies.get('row-save-failed').error, /503/)
  rejectRowError = false
  pageStatus = 200
  await open('b')

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
