import { app, BrowserWindow, dialog, shell, webContents } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

app.setPath('userData', join(process.env.ADE_LINKS_DATA, 'electron-data'))
const opened = []
const errors = []
let fail = false
// Exercise real Chromium window requests without launching the user's browser.
shell.openExternal = async (url) => {
  opened.push(url)
  if (fail) throw new Error('Browser launch failed')
}
dialog.showErrorBox = (title, message) => errors.push({ title, message })
await import('./index.js')

const wait = async (condition, label) => {
  console.log('WAIT', label)
  const deadline = Date.now() + 30000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(50)
  }
}

void app.whenReady().then(async () => {
  try {
    await wait(() => BrowserWindow.getAllWindows().length === 1, 'picker')
    const picker = BrowserWindow.getAllWindows()[0]
    await wait(
      async () =>
        !picker.webContents.isLoading() &&
        (await picker.webContents.executeJavaScript(
          '!!document.querySelector(".worktree-open")',
        )),
      'worktree',
    )
    await picker.webContents.executeJavaScript(
      'document.querySelector(".worktree-open").click()',
    )
    let page
    await wait(() => {
      page = webContents
        .getAllWebContents()
        .find((contents) => /^http:.*\/vscode\//.test(contents.getURL()))
      return !!page
    }, 'editor')
    const run = async (script) => {
      const timer = setTimeout(async () => {
        console.error(
          'STALLED',
          script,
          await page.executeJavaScript('document.body.innerText'),
        )
        app.exit(1)
      }, 15000)
      try {
        return await page.executeJavaScript(script, true)
      } finally {
        clearTimeout(timer)
      }
    }
    await wait(
      async () =>
        !page.isLoading() && (await run('globalThis.adeTest?.workbenchReady')),
      'workbench',
    )
    const originalUrl = page.getURL()
    const windowCount = BrowserWindow.getAllWindows().length
    const command = (id, ...args) =>
      run(
        `adeTest.executeCommand(${[id, ...args].map((value) => JSON.stringify(value)).join(',')})`,
      )
    await run(
      `adeTest.get('extensionService').whenInstalledExtensionsRegistered()`,
    )
    await run(
      `adeTest.get('storageService').store('http.linkProtectionTrustedDomains', JSON.stringify(['https://example.com', 'http://example.com']), 0, 0)`,
    )
    await wait(
      () =>
        run(
          `adeTest.get('extensionService').activateByEvent('*').then(() => true)`,
        ),
      'extension activation',
    )
    await command('ade-test.openExternal', 'https://example.com/extension')
    await wait(() => opened.length === 1, 'extension browser launch')
    assert.deepEqual(opened, ['https://example.com/extension'])

    const expectOpen = async (url, action) => {
      const count = opened.length
      await action()
      await wait(() => opened.length > count, url)
      await delay(100)
      assert.deepEqual(
        opened.slice(count),
        [url],
        'one browser launch per request',
      )
      assert.equal(page.getURL(), originalUrl)
      assert.equal(BrowserWindow.getAllWindows().length, windowCount)
    }
    for (const url of [
      'http://example.com/path?q=a%20b#section',
      'https://example.com/path?q=%26#fragment',
    ]) {
      await expectOpen(url, () =>
        run(`void window.open(${JSON.stringify(url)})`),
      )
    }
    await expectOpen('https://example.com/workbench', () =>
      run(
        `adeTest.get('openerService').open('https://example.com/workbench', { openExternal: true })`,
      ),
    )
    await command('ade-test.editorLink', 'https://example.com/editor')
    await wait(
      () => run(`!!document.querySelector('.detected-link')`),
      'editor link detection',
    )
    await expectOpen('https://example.com/editor', () =>
      command('editor.action.openLink'),
    )
    await command('ade-test.terminalLink', 'https://example.com/terminal')
    await wait(
      () =>
        run(
          `adeTest.get('terminalService').activeInstance?.xterm?.raw.buffer.active.getLine(0)?.translateToString(true).includes('https://example.com/terminal')`,
        ),
      'terminal output',
    )
    await expectOpen('https://example.com/terminal', () =>
      command('workbench.action.terminal.openUrlLink'),
    )
    const clickWebviewLink = async (url) => {
      let frame
      await wait(async () => {
        for (const candidate of page.mainFrame.framesInSubtree) {
          try {
            if (
              await candidate.executeJavaScript(
                `(async () => {
                  const link = document.querySelector('a[href="${url}"]');
                  if (!link || document.readyState !== 'complete') return false;
                  await document.fonts.ready;
                  const before = link.getBoundingClientRect();
                  // Load handlers and layout must settle before dispatching real input.
                  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                  const after = link.getBoundingClientRect();
                  return link.isConnected && after.width > 0 && after.height > 0
                    && ['x', 'y', 'width', 'height'].every(key => before[key] === after[key])
                    && link.contains(document.elementFromPoint(after.x + after.width / 2, after.y + after.height / 2));
                })()`,
              )
            ) {
              frame = candidate
              return true
            }
          } catch (error) {
            if (!/Render frame was disposed|Script not run/.test(String(error)))
              throw error
          }
        }
        return false
      }, 'webview link')
      await expectOpen(url, async () => {
        BrowserWindow.getAllWindows()
          .find((window) => window !== picker)
          .focus()
        page.focus()
        const inner = await frame.executeJavaScript(`(() => {
        const rect = document.querySelector('a[href="${url}"]').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`)
        const outer = await run(`(() => {
        const rect = document.querySelector('iframe.webview').getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      })()`)
        const position = {
          x: Math.round(inner.x + outer.x),
          y: Math.round(inner.y + outer.y),
        }
        page.debugger.attach('1.3')
        try {
          await page.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button: 'left',
            clickCount: 1,
            ...position,
          })
          await page.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            clickCount: 1,
            ...position,
          })
        } finally {
          page.debugger.detach()
        }
      })
    }
    await command('ade-test.webviewLink', 'https://example.com/webview')
    await clickWebviewLink('https://example.com/webview')
    await command('workbench.action.closeActiveEditor')
    await command('ade-test.editorLink', 'https://example.com/markdown', true)
    await clickWebviewLink('https://example.com/markdown')

    const beforeRejected = opened.length
    for (const url of [
      'file:///tmp/ade-link-test',
      'command:ade-test.command',
      'vscode://ade-test/link',
      'data:text/plain,link',
      'about:blank',
    ]) {
      await run(`void window.open(${JSON.stringify(url)})`)
    }
    await delay(200)
    assert.equal(
      opened.length,
      beforeRejected,
      'unsupported schemes never reach the OS',
    )
    await run(`location.href = 'https://example.com/blocked-navigation'`)
    await delay(200)
    assert.equal(
      page.getURL(),
      originalUrl,
      'external navigation stays blocked',
    )
    assert.equal(
      opened.length,
      beforeRejected,
      'blocked navigation does not launch a browser',
    )

    fail = true
    await expectOpen('https://example.com/failure', () =>
      run(`void window.open('https://example.com/failure')`),
    )
    assert.equal(errors.length, 1)
    assert.equal(errors[0].title, 'Unable to open link')
    fail = false
    await expectOpen('https://example.com/recovery', () =>
      run(`void window.open('https://example.com/recovery')`),
    )
    assert.equal(await run('adeTest.workbenchReady'), true)
    assert.equal(errors.length, 1)
    console.log(
      'PASS desktop web links, rejected schemes, navigation boundaries, and browser failure recovery',
    )
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
