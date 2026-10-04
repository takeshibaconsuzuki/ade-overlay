import { app, BrowserWindow, session } from 'electron'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import {
  commandOrControl,
  key,
  letterKey,
  openCommandPalette,
} from '../helpers/keyboard.mjs'
const input = JSON.parse(
  readFileSync(process.env.ADE_EDITOR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', input.userData)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const windows = []
const errors = []
const checks = []
const loads = [0, 0]
let disconnected = false
let syncRequests = 0
let sync
async function syncNow() {
  // Exercise the main coordinator's reconnect trigger without waiting a minute.
  const before = syncRequests
  await sync.sync()
  assert.ok(syncRequests > before, 'sync request after reconnect')
}
async function until(check, label) {
  const end = Date.now() + 25_000
  while (Date.now() < end) {
    if (await check()) return
    await delay(100)
  }
  throw new Error('Timed out: ' + label)
}
async function command(contents, text) {
  const window = BrowserWindow.fromWebContents(contents)
  window.show()
  window.focus()
  contents.focus()
  await openCommandPalette(contents)
  await key(contents, 'A', [commandOrControl])
  await contents.insertText('>' + text)
  await until(
    () =>
      contents.executeJavaScript(
        `Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).some(row => row.textContent.replace(/\\s/g, '').includes(${JSON.stringify(text.replace(/\s/g, ''))}))`,
      ),
    text,
  )
  await delay(200)
  await key(contents, 'Enter')
}
function observations(path) {
  const file = join(path, 'settings-observations.jsonl')
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
    : []
}
async function expectConfig(font, hotExit) {
  await until(
    () =>
      [input.project, input.second].every((path) => {
        const row = observations(path).at(-1)
        return row?.font === font && (!hotExit || row.hotExit === hotExit)
      }),
    `both remote hosts: font=${font}, hotExit=${hotExit}`,
  )
}
async function browserSettings(contents) {
  return contents.executeJavaScript(`new Promise((resolve, reject) => {
    const request = indexedDB.open('vscode-web-db');
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('vscode-userdata-store').objectStore('vscode-userdata-store').get('/User/settings.json');
      read.onsuccess = () => { db.close(); resolve(read.result === undefined ? undefined : typeof read.result === 'string' ? read.result : new TextDecoder().decode(read.result)); };
      read.onerror = () => reject(read.error);
    };
    request.onerror = () => reject(request.error);
  })`)
}
async function saveUserSettings(contents, text) {
  await command(contents, 'Preferences: Open User Settings (JSON)')
  await until(
    () =>
      contents.executeJavaScript(
        "document.body.innerText.includes('settings.json') && !!document.querySelector('.monaco-editor .view-lines')",
      ),
    'User settings editor',
  )
  await delay(200)
  const point = await contents.executeJavaScript(
    `(() => { const element = Array.from(document.querySelectorAll('.monaco-editor .view-lines')).at(-1); const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left + 15), y: Math.round(rect.top + 10) }; })()`,
  )
  contents.sendInputEvent({
    type: 'mouseDown',
    ...point,
    button: 'left',
    clickCount: 1,
  })
  contents.sendInputEvent({
    type: 'mouseUp',
    ...point,
    button: 'left',
    clickCount: 1,
  })
  await key(contents, 'A', [commandOrControl])
  await delay(100)
  await contents.insertText(text)
  await delay(100)
  // Chromium inserts this as typing, so remove Monaco's auto-closed brace.
  await key(contents, 'Delete')
  await letterKey(contents, 's', [commandOrControl])
  await until(
    async () => (await browserSettings(contents)) === text,
    'native save finished',
  )
  // VS Code can show User settings in a modal editor, where the command
  // palette does not open. Leave it before the next command.
  await key(contents, 'Escape')
}
async function run() {
  await app.whenReady()
  const shared = session.fromPartition('persist:settings-sync-test')
  const origin = new URL(input.url.replace(/^ws/, 'http'))
  const { EditorSettingsSync } = await import(
    pathToFileURL(input.syncModule).href
  )
  sync = new EditorSettingsSync(origin.origin)
  const tokens = new Map(
    input.sessions.map((item) => [`/editors/${item.id}/`, item.accessToken]),
  )
  shared.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = new URL(details.url)
    const path = /^\/editors\/[a-f0-9]{64}\//.exec(url.pathname)?.[0]
    if (url.host === origin.host && tokens.has(path))
      details.requestHeaders.Authorization = 'Bearer ' + tokens.get(path)
    callback({ requestHeaders: details.requestHeaders })
  })
  shared.webRequest.onBeforeRequest(
    { urls: ['*://*/editors/*/ade-settings-sync'] },
    (_details, callback) => {
      syncRequests++
      callback({ cancel: disconnected })
    },
  )
  for (let i = 0; i < input.sessions.length; i++) {
    const window = new BrowserWindow({
      width: 1050,
      height: 800,
      show: false,
      webPreferences: {
        session: shared,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    windows.push(window)
    window.webContents.on(
      'did-start-navigation',
      (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) loads[i]++
      },
    )
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) errors.push(message)
    })
    await window.loadURL(
      new URL(`/editors/${input.sessions[i].id}/`, origin).href,
    )
    sync.add(
      window.webContents,
      new URL(`/editors/${input.sessions[i].id}/`, origin),
      input.sessions[i].accessToken,
    )
    await until(
      () =>
        window.webContents.executeJavaScript(
          "!!document.querySelector('.explorer-viewlet')",
        ),
      'editor ready',
    )
  }
  const [first, second] = windows.map((window) => window.webContents)
  if (input.phase === 'restart') {
    await until(
      () => readFileSync(input.localSettings, 'utf8') === input.offlineText,
      'pending browser save synchronized after app restart',
    )
    await expectConfig(27, 'off')
    assert.equal(await browserSettings(first), input.offlineText)
    checks.push(
      'offline save timestamp survives app restart and wins over older local file',
    )
  } else {
    await expectConfig(23)
    assert.equal(
      await browserSettings(first),
      readFileSync(input.localSettings, 'utf8'),
    )
    checks.push('first use synchronizes the existing local settings')
    const pids = [input.project, input.second].map(
      (path) => observations(path).at(-1).pid,
    )
    const local =
      '{\n // Replace the entire file; preserve this comment.\n "editor.fontSize":31, "files.hotExit":"onExit", "editor.rulers":[77]\n}\n'
    writeFileSync(input.localSettings, local)
    await syncNow()
    await expectConfig(31, 'onExit')
    assert.equal(await browserSettings(second), local)
    for (const contents of [first, second])
      assert.deepEqual(
        await contents.executeJavaScript('globalThis.adeSettingsSync.read()'),
        { content: local, mtime: statSync(input.localSettings).mtimeMs },
        'copy notifications preserve the companion snapshot in both editors',
      )
    checks.push(
      'periodic local-to-browser whole-file replacement updates both live remote hosts',
    )
    const browser =
      '{ /* Browser save */ "editor.fontSize":29, "files.hotExit":"off" }'
    await saveUserSettings(second, browser)
    await syncNow()
    await until(
      () => readFileSync(input.localSettings, 'utf8') === browser,
      'periodic browser-to-local replacement',
    )
    await expectConfig(29, 'off')
    assert.deepEqual(observations(input.project).at(-1).rulers, [])
    const savedTime = statSync(input.localSettings).mtimeMs
    const requestCount = syncRequests
    await delay(6200)
    assert.equal(syncRequests, requestCount)
    await syncNow()
    assert.equal(statSync(input.localSettings).mtimeMs, savedTime)
    checks.push(
      'browser saves preserve text, remove omitted settings and do not echo on subsequent cycles',
    )
    // Hold an actual companion response while the user makes a newer save.
    // Timestamp recording must continue independently of the network request.
    const original = shared.fetch.bind(shared)
    let release
    shared.fetch = async (...args) => {
      const response = await original(...args)
      await new Promise((resolve) => {
        release = resolve
      })
      return response
    }
    writeFileSync(
      input.localSettings,
      '{ "editor.fontSize":37, "files.hotExit":"onExit" }',
    )
    const olderSave = statSync(input.localSettings).mtimeMs
    // This request is deliberately held below, so do not wait for completion.
    const pending = sync.sync()
    await until(() => release, 'companion reply held in flight')
    await saveUserSettings(second, browser)
    await until(async () => {
      const saved = await first.executeJavaScript(
        "JSON.parse(localStorage.getItem('ade.settings-sync.v2'))",
      )
      return saved.content === browser && saved.mtime > olderSave
    }, 'same-content native save advances the timestamp while a reply is pending')
    const intermediateBrowser =
      '{ /* Newer than the pending reply */ "editor.fontSize":33, "files.hotExit":"off" }'
    await saveUserSettings(second, intermediateBrowser)
    await until(async () => {
      const saved = await first.executeJavaScript(
        "JSON.parse(localStorage.getItem('ade.settings-sync.v2'))",
      )
      return saved.mtime > olderSave
    }, 'save timestamp recorded while companion reply is pending')
    // Return to the original content with a newer save time (A -> B -> A).
    // Content-only stale-reply protection would accept the older server reply.
    const newerBrowser = browser
    await saveUserSettings(second, newerBrowser)
    const latestSave = await first.executeJavaScript(
      'globalThis.adeSettingsSync.read()',
    )
    assert.equal(latestSave.content, newerBrowser)
    assert.ok(latestSave.mtime > olderSave)
    shared.fetch = original
    release()
    await pending
    assert.deepEqual(
      await first.executeJavaScript('globalThis.adeSettingsSync.read()'),
      latestSave,
    )
    await syncNow()
    await until(
      () => readFileSync(input.localSettings, 'utf8') === newerBrowser,
      'newer browser edit wins over the delayed reply',
    )
    await expectConfig(29, 'off')
    assert.equal(await browserSettings(first), newerBrowser)
    checks.push(
      'A to B to A saves retain their complete newer snapshot when a delayed reply arrives',
    )
    assert.deepEqual(
      [input.project, input.second].map(
        (path) => observations(path).at(-1).pid,
      ),
      pids,
    )
    assert.deepEqual(loads, [1, 1])
    checks.push(
      'no editor reload or remote extension-host restart during synchronization',
    )
    disconnected = true
    const beforeOffline = statSync(input.localSettings).mtimeMs
    await saveUserSettings(first, input.offlineText)
    await until(async () => {
      const saved = await first.executeJavaScript(
        "JSON.parse(localStorage.getItem('ade.settings-sync.v2'))",
      )
      return saved.mtime > beforeOffline
    }, 'offline browser save time recorded')
    assert.equal(readFileSync(input.localSettings, 'utf8'), newerBrowser)
    checks.push('disconnected save remains pending locally')
  }
  sync.close()
  shared.flushStorageData()
  writeFileSync(
    input.result,
    JSON.stringify({ ok: true, checks, errors }, null, 2),
  )
  app.exit(0)
}
run().catch(async (error) => {
  const diagnostics = []
  for (const window of windows) {
    try {
      diagnostics.push({
        body: await window.webContents.executeJavaScript(
          'document.body.innerText',
        ),
        metadata: await window.webContents.executeJavaScript(
          "localStorage.getItem('ade.settings-sync.v2')",
        ),
        settings: await browserSettings(window.webContents),
      })
    } catch {
      /* A crashed renderer may be unavailable. */
    }
  }
  writeFileSync(
    input.result,
    JSON.stringify(
      {
        ok: false,
        error: error.stack,
        checks,
        errors,
        diagnostics,
        observations: [input.project, input.second].map(observations),
        local: readFileSync(input.localSettings, 'utf8'),
      },
      null,
      2,
    ),
  )
  app.exit(1)
})
