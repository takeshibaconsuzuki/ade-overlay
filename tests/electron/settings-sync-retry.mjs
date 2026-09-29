import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const input = JSON.parse(
  readFileSync(process.env.ADE_EDITOR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', input.userData)
app.on('window-all-closed', () => {})
let stage = 'starting Electron'
const deadline = setTimeout(() => {
  writeFileSync(input.result, JSON.stringify({ ok: false, stage }))
  app.exit(1)
}, 20_000)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (await check()) return
    await delay(10)
  }
  throw new Error('Timed out: ' + stage)
}
const requests = { failed: 0, healthy: 0 }
let failedStatus = 403
let text = '{"editor.fontSize":23}'
let hold = false
let held
let heldSnapshot
let servedSnapshot
const received = []
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  if (!request.url.endsWith('/ade-settings-sync')) {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>Settings sync test</title>')
    return
  }
  assert.equal(request.headers.authorization, 'Bearer editor-token')
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => received.push(JSON.parse(body)))
  const failed = request.url.startsWith('/failed/')
  requests[failed ? 'failed' : 'healthy']++
  if (hold) {
    held = response
    heldSnapshot = { content: text, mtime: Date.now() }
    return
  }
  if (failed && failedStatus !== 200) {
    response.writeHead(failedStatus).end('Editor unavailable')
  } else {
    servedSnapshot = { content: text, mtime: Date.now() - 1000 }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(servedSnapshot))
  }
})

async function prepare(contents) {
  await contents.executeJavaScript(`
    // Storage observers must not start timers or issue network requests.
    globalThis.setInterval = globalThis.setTimeout = globalThis.fetch = () => { throw new Error('Unexpected browser polling'); };
    performance.mark('code/didStartWorkbench');
    new Promise((resolve, reject) => {
      const request = indexedDB.open('vscode-web-db');
      request.onupgradeneeded = () => request.result.createObjectStore('vscode-userdata-store');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
  `)
  await contents.executeJavaScript(input.script)
}

const readSnapshot = (contents) =>
  contents.executeJavaScript('globalThis.adeSettingsSync.read()')
async function save(contents, content) {
  const previous = await readSnapshot(contents)
  await contents.executeJavaScript(`new Promise((resolve, reject) => {
    const request = indexedDB.open('vscode-web-db');
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('vscode-userdata-store', 'readwrite');
      transaction.objectStore('vscode-userdata-store').put(new TextEncoder().encode(${JSON.stringify(content)}), '/User/settings.json');
      transaction.oncomplete = () => {
        db.close();
        const channel = new BroadcastChannel('vscode.indexedDB.vscode-userdata.changes');
        channel.postMessage([{ resource: { path: '/User/settings.json' } }]);
        channel.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  })`)
  await until(async () => (await readSnapshot(contents)).mtime > previous.mtime)
  return readSnapshot(contents)
}

async function run() {
  await app.whenReady()
  const { EditorSettingsSync } = await import(
    pathToFileURL(input.syncModule).href
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const windows = []
  const sync = new EditorSettingsSync(origin)
  try {
    for (const name of ['failed', 'healthy']) {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true },
      })
      windows.push(window)
      await window.loadURL(`${origin}/${name}/`)
      await prepare(window.webContents)
    }
    assert.deepEqual(requests, { failed: 0, healthy: 0 })
    const [failed, healthy] = windows.map((window) => window.webContents)
    stage = 'initializing a new browser snapshot'
    assert.deepEqual(await readSnapshot(failed), { content: '{}\n', mtime: 0 })
    for (const contents of [failed, healthy])
      sync.add(contents, new URL(contents.getURL()), 'editor-token')

    stage = 'falling back after HTTP 403'
    await sync.sync()
    assert.deepEqual(requests, { failed: 1, healthy: 1 })
    const shared = await failed.executeJavaScript(
      'globalThis.adeSettingsSync.read()',
    )
    assert.equal(shared.content, text)
    assert.equal(
      (await healthy.executeJavaScript('globalThis.adeSettingsSync.read()'))
        .content,
      text,
    )

    stage = 'reusing the healthy view for the next cycle'
    text = '{"editor.fontSize":29}'
    await sync.sync()
    assert.deepEqual(requests, { failed: 1, healthy: 2 })
    assert.equal(
      (await failed.executeJavaScript('globalThis.adeSettingsSync.read()'))
        .content,
      text,
    )
    await delay(100)
    for (const contents of [failed, healthy])
      assert.deepEqual(
        await readSnapshot(contents),
        servedSnapshot,
        'sync notifications and reads preserve the supplied save time',
      )
    assert.deepEqual(
      requests,
      { failed: 1, healthy: 2 },
      'no extra timer per view',
    )

    stage = 'protecting a same-content save from an older reply'
    const beforeSave = await readSnapshot(healthy)
    const sameContentSave = await save(healthy, beforeSave.content)
    assert.ok(sameContentSave.mtime > beforeSave.mtime)
    assert.equal(
      await healthy.executeJavaScript(
        `globalThis.adeSettingsSync.apply(${JSON.stringify(beforeSave)}, ${JSON.stringify({ content: '{"editor.fontSize":43}', mtime: beforeSave.mtime + 1 })})`,
      ),
      false,
      'a reply for the earlier snapshot cannot overwrite the repeated save',
    )
    assert.equal((await readSnapshot(failed)).content, beforeSave.content)

    stage = 'handing storage access to another view after destruction'
    windows[1].destroy()
    failedStatus = 200
    text = '{"editor.fontSize":31}'
    await sync.sync()
    assert.deepEqual(requests, { failed: 2, healthy: 2 })
    assert.equal(
      (await failed.executeJavaScript('globalThis.adeSettingsSync.read()'))
        .content,
      text,
    )

    stage =
      'syncing after workspace navigation without registering the view again'
    await failed.loadURL(
      `${origin}/failed/?workspace=test.code-workspace#selection`,
    )
    await prepare(failed)
    text = '{"editor.fontSize":35}'
    await sync.sync()
    assert.deepEqual(requests, { failed: 3, healthy: 2 })
    assert.equal((await readSnapshot(failed)).content, text)

    stage = 'protecting an A to B to A save from a delayed reply'
    const original = await readSnapshot(failed)
    text = '{"editor.fontSize":41}'
    hold = true
    const delayed = sync.sync()
    await until(() => held && received.length === 6)
    assert.deepEqual(received.at(-1), original)
    await delay(10)
    await save(failed, '{"editor.fontSize":51}')
    await delay(10)
    const latest = await save(failed, original.content)
    assert.ok(latest.mtime > original.mtime)
    held
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(heldSnapshot))
    await delayed
    held = undefined
    hold = false
    assert.deepEqual(
      await readSnapshot(failed),
      latest,
      'neither content nor mtime is overwritten',
    )
    assert.deepEqual(
      await failed.executeJavaScript(
        "JSON.parse(localStorage.getItem('ade.settings-sync.v2'))",
      ),
      latest,
    )

    stage = 'sending the entire newer save on the next cycle'
    text = latest.content
    await sync.sync()
    assert.deepEqual(received.at(-1), latest)

    stage = 'rejecting another page before evaluating the settings helper'
    const requestCount = requests.failed
    for (const target of [
      `${origin}/different/`,
      `${origin.replace('127.0.0.1', 'localhost')}/failed/`,
    ]) {
      await failed.loadURL(target)
      await failed.executeJavaScript(
        'void (globalThis.adeSettingsSync = { read() { globalThis.unexpectedRead = true; } })',
      )
      await sync.sync()
      assert.equal(
        await failed.executeJavaScript('globalThis.unexpectedRead'),
        undefined,
      )
      assert.equal(requests.failed, requestCount)
    }
    await failed.loadURL(`${origin}/failed/?workspace=another.code-workspace`)
    await prepare(failed)

    stage = 'coalescing triggers and aborting shutdown while HTTP is pending'
    hold = true
    const pending = sync.sync()
    assert.equal(sync.sync(), pending)
    await until(() => held)
    assert.equal(requests.failed, requestCount + 1)
    const started = performance.now()
    sync.close()
    assert.ok(
      performance.now() - started < 100,
      'close must not wait for the companion',
    )
    await pending
    await sync.sync()
    assert.equal(requests.failed, requestCount + 1)
  } finally {
    sync.close()
    held?.destroy()
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
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
