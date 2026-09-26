import { app, BrowserWindow, BaseWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { commandOrControl, key } from './keyboard.mjs'
const input = JSON.parse(
  readFileSync(process.env.ADE_EDITOR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', input.userData)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}
async function command(contents, text) {
  contents.focus()
  await key(contents, 'F1')
  await until(
    () =>
      contents.executeJavaScript(
        "!!document.querySelector('.quick-input-widget input')",
      ),
    'command palette',
  )
  await key(contents, 'A', [commandOrControl])
  await contents.insertText('>' + text)
  await until(
    () =>
      contents.executeJavaScript(
        `Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).some(row => row.textContent.replace(/\\s/g, '').includes(${JSON.stringify(text.replace(/\s/g, ''))}))`,
      ),
    `command ${text}`,
  )
  await delay(200)
  await key(contents, 'Enter')
}
async function assertEditorFits(contents) {
  const window = BaseWindow.getAllWindows().find((window) =>
    window.contentView.children.some(
      (view) => view.webContents?.id === contents.id,
    ),
  )
  assert.ok(window)
  const view = window.contentView.children.find(
    (view) => view.webContents?.id === contents.id,
  )
  const content = window.contentView.getBounds()
  assert.deepEqual(view.getBounds(), {
    x: 0,
    y: 0,
    width: content.width,
    height: content.height,
  })
  const bottom =
    await contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    const status = document.querySelector('.part.statusbar');
    resolve(status ? { bottom: status.getBoundingClientRect().bottom, height: status.getBoundingClientRect().height } : null);
  })))`)
  assert.ok(bottom?.height > 0, 'status bar is present')
  assert.ok(
    bottom.bottom * contents.getZoomFactor() <= content.height + 1,
    'status bar fits inside the visible window',
  )
}
async function run() {
  await import(pathToFileURL(input.main).href)
  await until(() => BrowserWindow.getAllWindows().length === 1, 'picker window')
  const picker = BrowserWindow.getAllWindows()[0].webContents
  await until(
    () =>
      picker.executeJavaScript(
        "document.querySelectorAll('.worktree-open').length === 2",
      ),
    'worktree buttons',
  )
  const open = async (path) =>
    picker.executeJavaScript(
      `window.companion.openEditor(${JSON.stringify({ project: input.project, path })})`,
    )
  await open(input.project)
  const editor = webContents
    .getAllWebContents()
    .find((contents) => contents.getURL().includes('/editors/'))
  assert.ok(editor)
  const errors = []
  editor.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message)
  })
  const body = () => editor.executeJavaScript('document.body.innerText')
  const terminalCommand = async (text) => {
    editor.focus()
    await editor.executeJavaScript(
      "document.querySelector('.xterm-helper-textarea').focus()",
    )
    for (const char of text)
      editor.sendInputEvent({ type: 'char', keyCode: char })
    await key(editor, 'Enter')
  }
  try {
    await until(
      () =>
        editor.executeJavaScript(
          "!!document.querySelector('.monaco-workbench') && !!document.querySelector('.explorer-viewlet')",
        ),
      'VS Code explorer',
    )
    await assertEditorFits(editor)
    await until(async () => {
      // Settings arrive asynchronously after the workbench restores. Query
      // again instead of waiting for a notification's old snapshot to change.
      await command(editor, 'ADE: Check Imported Extension')
      return (await body()).includes(
        input.phase === 'first'
          ? 'ADE_IMPORTED_23_NODE_TRUSTED'
          : 'ADE_IMPORTED_29_NODE_TRUSTED',
      )
    }, 'imported Node extension and settings')
    if (input.phase === 'first') {
      await key(editor, 'P', [commandOrControl])
      await delay(300)
      await editor.insertText('persist.txt')
      await delay(600)
      await key(editor, 'Enter')
      await until(
        () =>
          editor.executeJavaScript(
            '!!document.querySelector(\'.tab[aria-selected="true"]\')',
          ),
        'open file',
      )
      await command(editor, 'ADE: Change Imported Settings')
      await until(
        () =>
          editor.executeJavaScript(
            "Array.from(document.querySelectorAll('.view-line')).some(line => getComputedStyle(line).fontSize === '29px')",
          ),
        'edited user setting',
      )
      await command(editor, 'Terminal: Create New Terminal')
      await until(
        () => editor.executeJavaScript("!!document.querySelector('.xterm')"),
        'terminal',
      )
      await until(
        () =>
          editor.executeJavaScript(
            "document.querySelector('.xterm-accessibility-tree')?.textContent.includes('project with spaces')",
          ),
        'terminal prompt',
      )
      // Exercise VS Code's Paste action and the real browser permission flow.
      // Discard clipboard contents locally and paste only the fixture command.
      const pastedCommand =
        process.platform === 'win32'
          ? "$adePersistence = 'ADE_VARIABLE_OK'; echo ADE_TERMINAL_MARKER"
          : 'adePersistence=ADE_VARIABLE_OK; echo ADE_TERMINAL_MARKER'
      await editor.executeJavaScript(`void (() => {
        const read = navigator.clipboard.readText.bind(navigator.clipboard);
        globalThis.restoreClipboard = () => { navigator.clipboard.readText = read; };
        navigator.clipboard.readText = async () => {
          await read();
          return ${JSON.stringify(pastedCommand)};
        };
      })()`)
      try {
        await command(editor, 'Terminal: Paste into Active Terminal')
        await until(
          async () =>
            (
              await editor.executeJavaScript('document.body.textContent')
            ).includes('echo ADE_TERMINAL_MARKER'),
          'terminal paste action',
        )
        await key(editor, 'Enter')
      } finally {
        await editor.executeJavaScript('globalThis.restoreClipboard()')
      }
      await until(
        () =>
          editor.executeJavaScript(
            "Array.from(document.querySelectorAll('.xterm-accessibility-tree [role=listitem]')).some(row => row.textContent.trim() === 'ADE_TERMINAL_MARKER')",
          ),
        'terminal output',
      )
      const editorWindow = BaseWindow.getAllWindows().find(
        (window) => window.id !== BrowserWindow.getAllWindows()[0].id,
      )
      const windowId = editorWindow.id
      await open(input.second)
      assert.equal(BaseWindow.getAllWindows().length, 2)
      assert.ok(BaseWindow.fromId(windowId))
      const otherEditor = webContents
        .getAllWebContents()
        .find(
          (contents) =>
            contents.id !== editor.id &&
            contents.getURL().includes('/editors/'),
        )
      assert.equal(otherEditor.session, editor.session)
      await open(input.project)
      assert.equal(BaseWindow.getAllWindows().length, 2)
      await assertEditorFits(editor)
      assert.equal(editor.isDestroyed(), false)
      assert.ok((await body()).includes('ADE_TERMINAL_MARKER'))
      editorWindow.close()
      await until(
        () => BaseWindow.getAllWindows().length === 1,
        'close editor window',
      )
      await open(input.project)
      await until(
        () =>
          editor.executeJavaScript("document.visibilityState === 'visible'"),
        'reopened editor page is visible',
      )
      assert.equal(BaseWindow.getAllWindows().length, 2)
      await assertEditorFits(editor)
      assert.ok((await body()).includes('ADE_TERMINAL_MARKER'))
      await delay(2000)
    } else {
      await until(
        async () => (await body()).includes('ADE_TERMINAL_MARKER'),
        'restored terminal output',
      )
      assert.ok(
        await editor.executeJavaScript(
          "Array.from(document.querySelectorAll('.tab')).some(tab => tab.textContent.replace(/\\s/g, '').includes('persist.txt'))",
        ),
      )
      await terminalCommand('echo ADE_RESUMED_$adePersistence')
      await until(
        async () => (await body()).includes('ADE_RESUMED_ADE_VARIABLE_OK'),
        'same running shell after restart',
      )
    }
    writeFileSync(input.result, JSON.stringify({ ok: true, errors }))
    app.quit()
  } catch (error) {
    writeFileSync(input.screenshot, (await editor.capturePage()).toPNG())
    writeFileSync(
      input.result,
      JSON.stringify({
        error: error.stack,
        body: await body(),
        terminal: await editor.executeJavaScript(
          "document.querySelector('.xterm')?.outerHTML",
        ),
        sync: await editor.executeJavaScript(`({
          metadata: localStorage.getItem('ade.settings-sync.v2'),
          workbenchReady: performance.getEntriesByName('code/didStartWorkbench').length > 0,
          scripts: Array.from(document.scripts).map(script => script.src).filter(src => src.includes('ade-settings-sync')),
        })`),
        errors,
      }),
    )
    app.exit(1)
  }
}
run().catch((error) => {
  writeFileSync(input.result, JSON.stringify({ error: error.stack }))
  app.exit(1)
})
