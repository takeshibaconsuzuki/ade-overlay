import { app, BaseWindow, BrowserWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Server } from 'socket.io'

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

  main: path === 'a',
  locked: false,
  prunable: false,
  editorServer: 'running',
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
const sockets = new Server(server, {
  path: '/companion',
  addTrailingSlash: false,
  transports: ['websocket'],
  serveClient: false,
})
sockets.on('connection', (socket) => {
  client = socket
  connections++
  socket.emit('hello', { protocolVersion: 1 })
  socket.on('desktopOpenChatResponse', (message) =>
    chatReplies.set(message.id, message),
  )
  for (const command of ['companionListWorktrees', 'companionRefreshWorktrees'])
    socket.on(command, (_input, ack) => {
      const reply = (value) => ack({ ok: true, value })
      if (holdLists) heldList = reply
      else reply(snapshot)
    })
  socket.on('companionSetWorktreeError', (input, ack) => {
    rowErrors.push(input)
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      worktrees: snapshot.worktrees.map((row) =>
        row.path === input.path ? { ...row, error: input.error } : row,
      ),
    }
    socket.emit('desktopUpdateWorktrees', snapshot)
    ack({ ok: true, value: snapshot })
  })
  socket.on('companionStartEditorServer', (input, ack) => {
    const reply = (error) =>
      ack(
        error
          ? { ok: false, error }
          : {
              ok: true,
              value: { id: input.path.repeat(64), accessToken: 'c'.repeat(64) },
            },
      )
    if (holdEditorOpen) heldEditorOpen = reply
    else reply(rejectEditorOpen ? 'Server startup failed' : undefined)
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
  assert.equal(picker.getLastWebPreferences().sandbox, true)
  await until(() =>
    picker.executeJavaScript(
      "window.companion?.getState().then(state => state.status.state === 'connected' && !state.loading)",
    ),
  )
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

  stage = 'relaunching ADE reuses the picker, connection and retained editors'
  const show = pickerWindow.show.bind(pickerWindow)
  const focus = pickerWindow.focus.bind(pickerWindow)
  const isFocused = pickerWindow.isFocused.bind(pickerWindow)
  let shown = 0
  let focused = 0
  pickerWindow.show = () => {
    shown++
    show()
  }
  pickerWindow.focus = () => {
    focused++
    focus()
  }
  const beforeRelaunch = connections
  for (const alreadyFocused of [false, true]) {
    // Windows stay hidden in this fixture. Exercise both picker states without
    // taking focus from the developer's active application.
    pickerWindow.isFocused = () => alreadyFocused
    const beforeShow = shown
    const beforeFocus = focused
    await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./second-instance.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          // Existing configuration wins over a later launch's configuration.
          ADE_COMPANION_URL: alreadyFocused
            ? 'invalid companion URL'
            : process.env.ADE_COMPANION_URL,
        },
        windowsHide: true,
        timeout: 8000,
      },
    )
    await until(() => shown > beforeShow && focused > beforeFocus)
    assert.equal(connections, beforeRelaunch)
    assert.deepEqual(
      new Set(BaseWindow.getAllWindows()),
      new Set([pickerWindow, editor]),
    )
    assert.equal(view('a'), first)
    assert.equal(view('b'), second)
  }
  pickerWindow.show = show
  pickerWindow.focus = focus
  pickerWindow.isFocused = isFocused

  stage =
    'chat navigation selects retained and fresh worktrees through the real desktop handler'
  for (const path of ['a', 'c']) {
    client.emit('desktopOpenChat', {
      id: `chat-${path}`,
      input: { project: 'project', path },
    })
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
    client.emit('desktopOpenChat', {
      id,
      input: { project: 'project', path },
    })
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

  const finished = (id) => client.emit('desktopFinishOpenChat', id)
  const flush = () =>
    picker.executeJavaScript('window.companion.refreshWorktrees()')
  const activeIs = (path) =>
    assert.ok(
      BaseWindow.getAllWindows()
        .find((window) => window !== pickerWindow)
        .contentView.children.some((child) => child.webContents === view(path)),
    )
  // Row errors as the picker sees them, including this desktop's local ones.
  const rowError = (path) =>
    picker.executeJavaScript(
      `window.companion.getState().then(state => state.snapshot.worktrees.find(row => row.path === ${JSON.stringify(path)})?.error)`,
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

  stage = 'a page failing after its chat ended becomes a local row error'
  // A new revision lets the desktop accept the row that will hold the error.
  snapshot = {
    ...snapshot,
    revision: snapshot.revision + 1,
    worktrees: [...snapshot.worktrees, tree('f')],
  }
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
  await until(async () => /502/.test(await rowError('f')))
  assert.equal(rowErrors.length, 0)
  assert.equal(chatReplies.has('cancel-page'), false)
  await open('b')

  stage = 'chat page failures are local row errors and a reconnect clears them'
  pageStatus = 503
  navigate('page-failed', 'e')
  await until(() => chatReplies.has('page-failed'))
  const pageError = chatReplies.get('page-failed').error
  assert.match(pageError, /503/)
  await until(async () => (await rowError('e')) === pageError)
  assert.equal(rowErrors.length, 0)
  const connectionBeforeError = connections
  client.conn.close()
  await until(() => connections > connectionBeforeError)
  await until(() =>
    picker.executeJavaScript(
      "window.companion.getState().then(state => state.status.state === 'connected' && !state.loading)",
    ),
  )
  assert.equal(await rowError('e'), undefined)
  assert.equal(await rowError('f'), undefined)
  pageStatus = 200
  navigate('retry-page', 'e')
  await until(() => chatReplies.has('retry-page'))
  assert.equal(chatReplies.get('retry-page').error, undefined)
  assert.equal(await rowError('e'), undefined)

  stage = 'a superseded page failure becomes a local row error'
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
  // Supersession acknowledges the chat before the old page finishes failing.
  // Let that page close before reusing its worktree in the next scenario.
  await until(() => !view('f'))
  await until(async () => /502/.test(await rowError('f')))
  assert.equal(rowErrors.length, 0)

  stage = 'chat startup errors reach only the chat, never a row'
  rejectEditorOpen = true
  navigate('startup-failed', 'f')
  await until(() => chatReplies.has('startup-failed'))
  assert.equal(chatReplies.get('startup-failed').error, 'Server startup failed')
  assert.match(await rowError('f'), /502/)
  assert.equal(rowErrors.length, 0)
  rejectEditorOpen = false
  await open('b')

  stage = 'ignoring a stale list reply after a newer pushed update'
  holdLists = true
  const pending = picker.executeJavaScript(
    'window.companion.refreshWorktrees()',
  )
  await until(() => heldList)
  snapshot = { ...snapshot, revision: snapshot.revision + 1 }
  // WebSocket ordering guarantees the broadcast is handled before the old reply.
  client.emit('desktopUpdateWorktrees', snapshot)
  heldList({
    ...snapshot,
    revision: snapshot.revision - 1,
    worktrees: [tree('a')],
  })
  await pending
  assert.equal(second.isDestroyed(), false)
  holdLists = false

  stage = 'recovering a deletion while the picker is reloading'
  // No picker subscription or network request can drive reconciliation here.
  await picker.loadURL('about:blank')
  const before = connections
  client.conn.close()
  // A restarted companion can also reset its revision counter.
  snapshot = { ...snapshot, revision: 0, worktrees: [tree('a')] }
  await until(() => connections > before)
  await until(() => second.isDestroyed())
  await picker.loadURL(origin)
  assert.equal(first.isDestroyed(), false)
  await open('a')
  assert.equal(view('a').id, first.id, 'surviving editor remains loaded')

  stage =
    'closing the picker quits with active and hidden editors despite unload vetoes'
  snapshot = { ...snapshot, revision: 1, worktrees: [tree('a'), tree('b')] }
  await picker.executeJavaScript('window.companion.refreshWorktrees()')
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
  client.conn.close()
  await until(() =>
    picker.executeJavaScript(
      "window.companion.getState().then(state => state.status.state !== 'connected')",
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
