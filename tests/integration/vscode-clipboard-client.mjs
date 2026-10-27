import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  webContents,
} from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

app.setPath('userData', join(process.env.ADE_CLIPBOARD_DATA, 'electron-data'))
await import('./index.js')

async function wait(condition, label) {
  const deadline = Date.now() + 30000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(50)
  }
}

async function readText() {
  const item = (await clipboard.read()).find((item) =>
    item.types.includes('text/plain'),
  )
  return item ? (await item.getType('text/plain')).text() : ''
}

async function writeText(text) {
  await clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
    }),
  ])
}

void app.whenReady().then(async () => {
  let originalClipboard
  let failure
  try {
    originalClipboard = await Promise.all(
      (await clipboard.read())
        .filter((item) => item.types.length > 0)
        .map(
          async (item) =>
            new ClipboardItem(
              Object.fromEntries(
                await Promise.all(
                  item.types.map(async (type) => [
                    type,
                    await item.getType(type),
                  ]),
                ),
              ),
            ),
        ),
    )
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
    const run = (script) => page.executeJavaScript(script)
    await wait(
      async () =>
        !page.isLoading() && (await run('globalThis.adeTest?.workbenchReady')),
      'workbench',
    )
    await run(
      'adeTest.get("workspaceTrustManagementService").setWorkspaceTrust(true)',
    )
    BrowserWindow.getAllWindows()
      .find((window) => window !== picker)
      .focus()
    page.focus()
    await run(`(async () => {
      const service = adeTest.get('terminalService');
      const terminal = await service.createTerminal({
        config: { executable: ${JSON.stringify(process.env.ADE_CLIPBOARD_NODE)}, args: [${JSON.stringify(process.env.ADE_CLIPBOARD_CLI)}], waitOnExit: false },
        location: 1,
      });
      service.setActiveInstance(terminal);
      await adeTest.get('terminalGroupService').showPanel(true);
      await terminal.xtermReadyPromise;
      await terminal.focusWhenReady(true);
    })()`)
    const outputContains = (marker) =>
      run(`(() => {
      const terminal = adeTest.get('terminalService').activeInstance;
      if (!terminal?.xterm?._clipboardAddon) return false;
      const buffer = terminal.xterm.raw.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer.getLine(i)?.translateToString(true) === ${JSON.stringify(marker)}) return true;
      }
      return false;
    })()`)
    await wait(
      () => outputContains('CLIPBOARD_READY'),
      'PTY and clipboard addon',
    )

    await writeText('previous clipboard contents')
    for (const [index, scenario] of [
      { target: 'c', text: 'ADE OSC52 test', terminator: '\x07' },
      { target: '', text: '日本語 🦊\nsecond line', terminator: '\x1b\\' },
    ].entries()) {
      const marker = `CLIPBOARD_COMPLETE_${index}`
      const input = JSON.stringify({ ...scenario, marker })
      await run(
        `adeTest.get('terminalService').activeInstance.sendText(${JSON.stringify(input)}, true)`,
      )
      await wait(() => outputContains(marker), 'OSC 52 parsed')
      assert.equal(
        await readText(),
        scenario.text,
        'OSC 52 reaches the native clipboard',
      )
    }

    await writeText('native clipboard changed externally')
    assert.equal(
      await run("adeTest.get('clipboardService').readText('clipboard')"),
      'native clipboard changed externally',
    )
    await run(
      "adeTest.get('clipboardService').writeText('private value', 'ade-test')",
    )
    assert.equal(
      await run("adeTest.get('clipboardService').readText('ade-test')"),
      'private value',
    )
    assert.equal(
      await readText(),
      'native clipboard changed externally',
      'other named clipboard stores stay private',
    )

    await run("adeTest.get('clipboardService').writeText('ordinary copy')")
    assert.equal(
      await readText(),
      'ordinary copy',
      'unnamed writes still reach the native clipboard',
    )
    console.log(
      'PASS OSC 52 native writes, Unicode, clipboard reads, and private named stores',
    )
  } catch (error) {
    failure = error
  } finally {
    if (originalClipboard) await clipboard.write(originalClipboard)
  }
  if (failure) {
    console.error(failure)
    app.exit(1)
  } else app.quit()
})
