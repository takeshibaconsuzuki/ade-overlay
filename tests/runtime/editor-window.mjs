import { app, BrowserWindow, BaseWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { basename, join } from 'node:path'
import { commandOrControl, key } from '../helpers/keyboard.mjs'
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
    await editor.executeJavaScript(`void (() => {
      const read = navigator.clipboard.readText;
      globalThis.restoreFixtureClipboard = () => { navigator.clipboard.readText = read; };
      navigator.clipboard.readText = async () => ${JSON.stringify(text)};
    })()`)
    try {
      await command(editor, 'Terminal: Paste into Active Terminal')
      await delay(200)
      await key(editor, 'Enter')
    } finally {
      await editor.executeJavaScript('globalThis.restoreFixtureClipboard()')
    }
  }
  const mouseReports = () => {
    try {
      return readFileSync(join(input.project, 'mouse-events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  const moveMouse = async () => {
    const point = await editor.executeJavaScript(`(() => {
      const rect = document.querySelector('.xterm-screen').getBoundingClientRect();
      return { x: Math.round(rect.left + 40), y: Math.round(rect.top + 40) };
    })()`)
    editor.sendInputEvent({ type: 'mouseMove', ...point })
    editor.sendInputEvent({
      type: 'mouseMove',
      x: point.x + 20,
      y: point.y + 20,
    })
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
        input.phase === 'second'
          ? 'ADE_IMPORTED_29_NODE_TRUSTED'
          : 'ADE_IMPORTED_23_NODE_TRUSTED',
      )
    }, 'imported Node extension and settings')
    if (input.phase === 'paste') {
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII='
      const html = `<p>First</p><img src="data:image/png;base64,${png}"><p>Middle</p><img src="data:image/png;base64,${png}"><p>Last</p>`
      const deliveries = () => {
        try {
          return (
            readFileSync(join(input.project, 'paste-input.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
              // The VS Code command also sends the empty clipboard result.
              .filter(
                ({ text }) => text !== '\x1b[200~\x1b[201~' && text !== '',
              )
          )
        } catch (error) {
          if (error.code === 'ENOENT') return []
          throw error
        }
      }
      const frames = (text) =>
        text
          .split('\x1b[200~')
          .slice(1)
          .map((part) => {
            assert.ok(part.endsWith('\x1b[201~'), 'no Enter appended')
            return part.slice(0, -6)
          })
      await editor.executeJavaScript(`(() => {
        const read = navigator.clipboard.read;
        navigator.clipboard.read = async () => [new ClipboardItem({
          'text/plain': new Blob(['ADE_PASTE_TEXT'], { type: 'text/plain' }),
          'text/html': new Blob([${JSON.stringify(html)}], { type: 'text/html' }),
        })];
        globalThis.restorePasteFixture = () => { navigator.clipboard.read = read; };
      })()`)
      try {
        let count = 0
        for (const setting of ['default', 'hiddenIcons', 'hiddenTabs']) {
          if (setting !== 'default')
            await command(editor, `ADE: Paste Fixture ${setting}`)
          for (const provider of ['codex', 'claude', 'ordinary']) {
            await command(editor, `ADE: Paste Fixture ${provider}`)
            await until(
              () =>
                editor.executeJavaScript(
                  `!!document.querySelector('.editor-group-container.active .xterm textarea')`,
                ),
              'terminal input',
            )
            await editor.executeJavaScript(
              `document.querySelector('.editor-group-container.active .xterm textarea').focus()`,
            )
            if (setting === 'hiddenIcons')
              assert.equal(
                await editor.executeJavaScript(
                  `document.querySelectorAll('.tab.active .codicon-terminal').length`,
                ),
                0,
              )
            if (setting === 'hiddenTabs')
              assert.equal(
                await editor.executeJavaScript(
                  `document.querySelectorAll('.tab').length`,
                ),
                0,
              )
            for (const mechanism of ['command', 'event']) {
              if (mechanism === 'command')
                await command(editor, 'Terminal: Paste into Active Terminal')
              else
                await editor.executeJavaScript(
                  `(() => {
                const data = new DataTransfer();
                data.setData('text/plain', 'ADE_NATIVE_TEXT');
                data.setData('text/html', ${JSON.stringify(html)});
                document.querySelector('.editor-group-container.active .xterm textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
              })()`,
                  true,
                )
              if (provider === 'ordinary') {
                const marker =
                  mechanism === 'command' ? 'ADE_PASTE_TEXT' : 'ADE_NATIVE_TEXT'
                await until(
                  () =>
                    editor.executeJavaScript(
                      `document.querySelector('.editor-group-container.active .xterm-accessibility-tree')?.textContent.includes('${marker}')`,
                    ),
                  'ordinary terminal receives text',
                )
                assert.equal(deliveries().length, count)
              } else {
                count++
                await until(
                  () => deliveries().length >= count,
                  `provider payload delivered to terminal (${setting}/${provider}/${mechanism})`,
                )
                assert.equal(
                  deliveries().length,
                  count,
                  JSON.stringify(deliveries()),
                )
                const result = deliveries().at(-1)
                assert.equal(result.terminalId, `fixture-${provider}`)
                const parts = frames(result.text)
                let paths
                if (provider === 'codex') {
                  assert.equal(parts.length, 5)
                  assert.deepEqual(
                    [parts[0], parts[2], parts[4]],
                    ['First', 'Middle', 'Last'],
                  )
                  paths = [new URL(parts[1]), new URL(parts[3])]
                } else {
                  assert.equal(parts.length, 1)
                  const ordered = parts[0].split('\r')
                  assert.deepEqual(
                    [ordered[0], ordered[2], ordered[4]],
                    ['First', 'Middle', 'Last'],
                  )
                  assert.ok(
                    ordered[1].startsWith('@') && ordered[3].startsWith('@'),
                  )
                  paths = [
                    JSON.parse(ordered[1].slice(1)),
                    JSON.parse(ordered[3].slice(1)),
                  ]
                }
                for (const path of paths)
                  assert.deepEqual(
                    readFileSync(path),
                    Buffer.from(png, 'base64'),
                  )
              }
            }
            if (setting === 'default') {
              // Drop desktop files where the pointer would land: on the
              // overlay VS Code raises over the terminal tab while dragging.
              assert.deepEqual(
                await editor.executeJavaScript(
                  `(() => {
                const data = new DataTransfer();
                data.items.add(new File(['ADE_DROP_TEXT'], 'ADE drop.txt', { type: 'text/plain' }));
                data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png)}), character => character.charCodeAt(0))], 'drop.png', { type: 'image/png' }));
                const terminal = document.querySelector('.editor-group-container.active .xterm');
                const bounds = terminal.getBoundingClientRect();
                const options = { dataTransfer: data, bubbles: true, cancelable: true, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 };
                terminal.dispatchEvent(new DragEvent('dragenter', options));
                const target = document.elementFromPoint(options.clientX, options.clientY);
                const overlay = target?.closest('#monaco-workbench-editor-drop-overlay, .terminal-drop-overlay');
                target?.dispatchEvent(new DragEvent('drop', options));
                return {
                  target: overlay?.id || overlay?.className || target?.className || null,
                  remaining: document.querySelectorAll('#monaco-workbench-editor-drop-overlay, .terminal-drop-overlay').length,
                };
              })()`,
                  true,
                ),
                // A plain drop lands on the editor group's overlay, and
                // consuming it leaves no VS Code overlay behind.
                {
                  target: 'monaco-workbench-editor-drop-overlay',
                  remaining: 0,
                },
              )
              if (provider === 'ordinary') {
                await delay(500)
                assert.equal(deliveries().length, count)
              } else {
                count++
                await until(
                  () => deliveries().length >= count,
                  `dropped files delivered to terminal (${provider})`,
                )
                const result = deliveries().at(-1)
                assert.equal(result.terminalId, `fixture-${provider}`)
                const parts = frames(result.text)
                let paths
                if (provider === 'codex') {
                  assert.equal(parts.length, 2)
                  assert.match(parts[0], /^".+" $/)
                  paths = [parts[0].slice(1, -2), new URL(parts[1])]
                } else {
                  assert.equal(parts.length, 1)
                  paths = parts[0]
                    .split('\r')
                    .filter(Boolean)
                    .map((mention) => {
                      assert.ok(mention.startsWith('@'))
                      return JSON.parse(mention.slice(1))
                    })
                }
                assert.equal(basename(paths[0]), 'ADE drop.txt')
                assert.equal(readFileSync(paths[0], 'utf8'), 'ADE_DROP_TEXT')
                assert.deepEqual(
                  readFileSync(paths[1]),
                  Buffer.from(png, 'base64'),
                )
              }
            }
            await command(editor, 'ADE: Paste Fixture close')
          }
        }
      } finally {
        await editor.executeJavaScript('restorePasteFixture()')
        await command(editor, 'ADE: Paste Fixture close')
      }
      writeFileSync(input.result, JSON.stringify({ ok: true, errors }))
      BrowserWindow.getAllWindows()[0].close()
      return
    }
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
      // Exercise editor terminals, as used by the ADE launcher, across quit.
      await command(editor, 'Terminal: Create New Terminal in Editor Area')
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
      const executable =
        "'" +
        input.node.replaceAll(
          "'",
          process.platform === 'win32' ? "''" : "'\\''",
        ) +
        "'"
      await terminalCommand(
        `${process.platform === 'win32' ? '& ' : ''}${executable} ./terminal-mouse.cjs`,
      )
      await until(
        async () => (await body()).includes('ADE_MOUSE_READY'),
        'mouse application starts',
      )
      await moveMouse()
      await until(
        () => mouseReports().some((event) => event.data.startsWith('\x1b[<')),
        'SGR mouse reports before restart',
      )
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
      const before = mouseReports()
      await moveMouse()
      await until(
        () => mouseReports().length > before.length,
        'mouse report after restart',
      )
      const after = mouseReports().slice(before.length)
      assert.ok(
        after.every((event) => event.pid === before[0].pid),
        'same mouse application survives restart',
      )
      assert.ok(
        after.every((event) => event.data.startsWith('\x1b[<')),
        'reconnected mouse reports keep SGR encoding',
      )
      await terminalCommand('q')
      await delay(500)
      await terminalCommand('echo ADE_RESUMED_$adePersistence')
      await until(
        async () => (await body()).includes('ADE_RESUMED_ADE_VARIABLE_OK'),
        'same running shell after restart',
      )
    }
    writeFileSync(input.result, JSON.stringify({ ok: true, errors }))
    // Use the user's exit path: closing the picker shuts down all editor pages.
    BrowserWindow.getAllWindows()[0].close()
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
