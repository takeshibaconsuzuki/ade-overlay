import { app, BaseWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const input = JSON.parse(
  readFileSync(process.env.ADE_EDITOR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', input.userData)
// Test real navigation without showing windows on the developer's desktop.
BaseWindow.prototype.show = function () {}
app.on('window-all-closed', () => {})
const checks = []
let stage = 'starting Electron'
const deadline = setTimeout(() => {
  writeFileSync(
    input.result,
    JSON.stringify({ ok: false, checks, error: `Timed out: ${stage}` }),
  )
  app.exit(1)
}, 20_000)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (await check()) return
    await delay(20)
  }
  throw new Error('Timed out waiting for editor navigation')
}

async function run() {
  await app.whenReady()
  stage = 'importing editor window'
  const { EditorWindow } = await import(pathToFileURL(input.editorModule).href)
  const statuses = new Map()
  const requests = new Map()
  const pending = new Set()
  const documents = new Map()
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    response.setHeader('Cache-Control', 'no-store')
    if (path.endsWith('/pending.png')) {
      pending.add(response)
      response.once('close', () => pending.delete(response))
      return // document readiness must not wait for images
    }
    if (path.endsWith('/missing.png') || path.endsWith('/frame')) {
      response.writeHead(502).end('Subresource failure')
      return
    }
    requests.set(path, (requests.get(path) ?? 0) + 1)
    const status = statuses.get(path) ?? 200
    if (status === 'hold') {
      documents.set(path, response)
      response.once('close', () => {
        if (documents.get(path) === response) documents.delete(path)
      })
      return
    }
    if (status === 'reset') {
      request.socket.destroy()
      return
    }
    response.writeHead(status, { 'Content-Type': 'text/html' })
    response.end(
      status === 200
        ? '<!doctype html><body>Editor ready<img src="pending.png"><img src="missing.png"><iframe src="frame"></iframe></body>'
        : 'Temporary editor failure',
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `ws://127.0.0.1:${server.address().port}/companion`
  const manager = new EditorWindow(url)
  const editor = (name, token = 'test-editor-token') => ({
    id: name.repeat(64),
    accessToken: token,
  })
  const editorPath = (session) => `/editors/${session.id}/`
  const worktree = (name) => ({ project: 'test-project', path: name })
  const open = async (session, name) => {
    const before = requests.get(editorPath(session)) ?? 0
    await manager.open(session, worktree(name))
    if ((requests.get(editorPath(session)) ?? 0) > before) {
      // Opening must finish while the image is pending. Release it afterwards
      // because Electron's executeJavaScript waits for the load to finish.
      await until(() => pending.size > 0)
      for (const response of pending) response.writeHead(200).end()
      pending.clear()
    }
  }
  const view = (session) =>
    webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().endsWith(editorPath(session)))
  try {
    const healthy = editor('a')
    stage = 'opening healthy document with unfinished subresources'
    await open(healthy, 'healthy')
    const healthyView = view(healthy)
    assert.ok(healthyView)
    assert.match(
      await healthyView.executeJavaScript('document.body.innerText'),
      /Editor ready/,
    )
    checks.push(
      'successful document opens despite failed and unfinished subresources',
    )

    stage = 'hiding and reopening a retained editor'
    const editorWindow = BaseWindow.getAllWindows()[0]
    const retainedView = editorWindow.contentView.children.find(
      (child) => child.webContents === healthyView,
    )
    const visibility = () =>
      healthyView.executeJavaScript('document.visibilityState')
    assert.equal(retainedView.getVisible(), true)
    editorWindow.close()
    assert.equal(retainedView.getVisible(), false)
    await until(async () => (await visibility()) === 'hidden')
    await open(healthy, 'healthy')
    assert.equal(retainedView.getVisible(), true)
    assert.equal(view(healthy), healthyView)
    assert.equal(requests.get(editorPath(healthy)), 1)
    checks.push('closing hides the retained page and reopening reuses its view')

    for (const [name, status] of [
      ['b', 502],
      ['c', 403],
      ['d', 404],
      ['e', 'reset'],
    ]) {
      const session = editor(name)
      stage = `rejecting ${status} document`
      statuses.set(editorPath(session), status)
      await assert.rejects(
        open(session, name),
        status === 'reset' ? undefined : new RegExp(`HTTP ${status}`),
      )
      await until(() => !view(session))
      assert.ok(!healthyView.isDestroyed())
      await open(healthy, 'healthy')
      assert.equal(view(healthy).id, healthyView.id)
      assert.equal(requests.get(editorPath(healthy)), 1)
      statuses.set(editorPath(session), 200)
      stage = `reopening after ${status}`
      const before = requests.get(editorPath(session))
      await open(session, name)
      assert.equal(requests.get(editorPath(session)), before + 1)
      assert.match(
        await view(session).executeJavaScript('document.body.innerText'),
        /Editor ready/,
      )
      await open(session, name)
      assert.equal(requests.get(editorPath(session)), before + 1)
      checks.push(
        `${status} failure is discarded and reopening with the same token retries`,
      )
    }

    // A failed reload after token rotation must also invalidate a retained view.
    statuses.set(editorPath(healthy), 502)
    stage = 'reloading after token rotation'
    const rotated = { ...healthy, accessToken: 'rotated-editor-token' }
    await assert.rejects(open(rotated, 'healthy'), /HTTP 502/)
    await until(() => !view(healthy))
    statuses.set(editorPath(healthy), 200)
    await open(rotated, 'healthy')
    assert.equal(requests.get(editorPath(healthy)), 3)
    checks.push('failed token-rotation reload retries on the next open')

    for (const closeWindow of [false, true]) {
      stage = `reopening crashed renderer with window ${closeWindow ? 'closed' : 'open'}`
      const crashed = view(rotated)
      const gone = new Promise((resolve) =>
        crashed.once('render-process-gone', resolve),
      )
      crashed.forcefullyCrashRenderer()
      await gone
      assert.equal(crashed.isCrashed(), true)
      if (closeWindow)
        for (const window of BaseWindow.getAllWindows()) window.close()
      const before = requests.get(editorPath(rotated))
      await open(rotated, 'healthy')
      const recovered = view(rotated)
      assert.equal(recovered.isCrashed(), false)
      assert.equal(requests.get(editorPath(rotated)), before + 1)
      assert.match(
        await recovered.executeJavaScript('document.body.innerText'),
        /Editor ready/,
      )
      await open(rotated, 'healthy')
      assert.equal(
        requests.get(editorPath(rotated)),
        before + 1,
        'healthy views still reuse the loaded document',
      )
      checks.push(
        `crashed renderer reloads with the same token and window ${closeWindow ? 'closed' : 'open'}`,
      )
    }

    for (const status of [502, 'reset', 'hold']) {
      stage = `retrying a retained view after background reload ${status}`
      const retained = view(rotated)
      statuses.set(editorPath(rotated), status)
      const stopped = new Promise((resolve) =>
        retained.once('did-stop-loading', resolve),
      )
      retained.reload()
      if (status === 'hold') {
        await until(() => documents.has(editorPath(rotated)))
        retained.stop()
      }
      await stopped
      statuses.set(editorPath(rotated), 200)
      const before = requests.get(editorPath(rotated))
      await open(rotated, 'healthy')
      assert.equal(requests.get(editorPath(rotated)), before + 1)
      assert.match(
        await view(rotated).executeJavaScript('document.body.innerText'),
        /Editor ready/,
      )
      checks.push(`background reload ${status} is retried on reopening`)
    }

    stage = 'selecting a view during a successful background reload'
    const retained = view(rotated)
    statuses.set(editorPath(rotated), 'hold')
    const beforeReload = requests.get(editorPath(rotated))
    retained.reload()
    await until(() => documents.has(editorPath(rotated)))
    let selected = false
    const selecting = manager.open(rotated, worktree('healthy')).then(() => {
      selected = true
    })
    await delay(50)
    assert.equal(selected, false, 'open waits for the current document')
    assert.equal(
      requests.get(editorPath(rotated)),
      beforeReload + 1,
      'open does not duplicate an active load',
    )
    documents
      .get(editorPath(rotated))
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end('<!doctype html><body>Reloaded editor</body>')
    await selecting
    await manager.open(rotated, worktree('healthy'))
    assert.equal(view(rotated).id, retained.id)
    assert.equal(requests.get(editorPath(rotated)), beforeReload + 1)
    statuses.set(editorPath(rotated), 200)
    checks.push('successful background reload is awaited and reused')

    stage = 'superseding an initial navigation in the same view'
    const slow = editor('f')
    statuses.set(editorPath(slow), 'hold')
    const opening = manager.open(slow, worktree('slow'))
    await until(() => documents.has(editorPath(slow)))
    const loading = BaseWindow.getAllWindows()
      .flatMap((window) => window.contentView.children)
      .find((child) => child.webContents)?.webContents
    assert.ok(loading)
    statuses.set(editorPath(slow), 200)
    const reloading = loading.loadURL(
      new URL(editorPath(slow), url.replace('ws:', 'http:')).href,
    )
    await opening
    await until(() => pending.size > 0)
    for (const response of pending) response.writeHead(200).end()
    pending.clear()
    await reloading
    assert.equal(view(slow).id, loading.id)
    assert.equal(loading.isDestroyed(), false)
    checks.push(
      'an older navigation rejection does not invalidate the replacement document',
    )

    stage = 'rotating tokens while an initial navigation is pending'
    const replaced = editor('g')
    statuses.set(editorPath(replaced), 'hold')
    const cancelled = assert.rejects(
      manager.open(replaced, worktree('replaced')),
      /closed/,
    )
    await until(() => documents.has(editorPath(replaced)))
    statuses.set(editorPath(replaced), 200)
    const replacement = { ...replaced, accessToken: 'new-token' }
    await open(replacement, 'replaced')
    await cancelled
    assert.equal(view(replacement).isDestroyed(), false)
    await open(replacement, 'replaced')
    checks.push(
      'disposed view callbacks cannot remove a new view with the same URL',
    )
  } finally {
    stage = 'closing fixture'
    manager.close()
    for (const window of BaseWindow.getAllWindows()) window.close()
    for (const response of documents.values()) response.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  writeFileSync(input.result, JSON.stringify({ ok: true, checks }))
  clearTimeout(deadline)
  app.exit(0)
}
run().catch((error) => {
  writeFileSync(
    input.result,
    JSON.stringify({ ok: false, checks, error: error.stack }),
  )
  app.exit(1)
})
