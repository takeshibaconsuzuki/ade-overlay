import { app, BrowserWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const directory = process.env.ADE_ENABLEMENT_DATA
app.setPath('userData', join(directory, 'electron-data'))
await import('./index.js')
const wait = async (condition, label) => {
  const deadline = Date.now() + 30000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(50)
  }
}
const activations = async () => {
  try {
    return (await readFile(join(directory, 'activations'), 'utf8')).length
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}
const setHost = async (action) => {
  const response = await fetch(
    `${process.env.ADE_ENABLEMENT_CONTROL}/${action}`,
  )
  assert.equal(response.status, 200)
}

void app.whenReady().then(async () => {
  try {
    await wait(() => BrowserWindow.getAllWindows().length === 1, 'picker')
    const picker = BrowserWindow.getAllWindows()[0]
    await wait(
      async () =>
        !picker.webContents.isLoading() &&
        (await picker.webContents.executeJavaScript(
          'document.querySelectorAll(".worktree-open").length === 1',
        )),
      'worktree',
    )
    await picker.webContents.executeJavaScript(
      'document.querySelector(".worktree-open").click()',
    )
    const pages = () =>
      webContents
        .getAllWebContents()
        .filter((page) => /^http:.*\/vscode\//.test(page.getURL()))
    await wait(() => pages().length === 1, 'editor')
    let page = pages()[0]
    const run = (script) => page.executeJavaScript(script)
    const ready = async () => {
      await wait(
        async () =>
          !page.isLoading() &&
          (await run('globalThis.adeHandle?.workbenchReady')),
        'workbench',
      )
      await run(
        'adeHandle.get("extensionService").whenInstalledExtensionsRegistered()',
      )
    }
    const reload = async () => {
      const loaded = new Promise((resolve) =>
        page.once('did-finish-load', resolve),
      )
      page.reload()
      await loaded
    }
    const disabled = () =>
      run(
        'adeHandle.get("IGlobalExtensionEnablementService").getDisabledExtensions().some(e => e.id === "ade-test.enablement")',
      )
    await ready()
    assert.equal(await disabled(), true)
    assert.equal(await activations(), 0, 'disabled extension never activated')
    await setHost('enable')
    await delay(300)
    assert.equal(await disabled(), true, 'no continuous synchronization')
    await reload()
    await ready()
    await wait(
      async () => (await activations()) === 1,
      'host re-enabled extension activates after reload',
    )
    assert.equal(await disabled(), false)

    // Local global choices last only until startup; workspace overrides persist.
    await run(
      'adeHandle.get("IGlobalExtensionEnablementService").disableExtension({ id: "ade-test.enablement" })',
    )
    assert.equal(await disabled(), true)
    await reload()
    await ready()
    assert.equal(await disabled(), false, 'startup restores host global choice')
    await wait(async () => (await activations()) >= 2, 'extension reactivated')
    const beforeDisabledReload = await activations()
    await setHost('disable')
    await reload()
    await ready()
    assert.equal(await disabled(), true)
    assert.equal(
      await activations(),
      beforeDisabledReload,
      'previously enabled extension cannot activate during disabled startup',
    )

    await run(`(async () => {
      const h = adeHandle;
      const extension = (await h.get('extensionManagementService').getInstalled()).find(e => e.identifier.id === 'ade-test.enablement');
      await h.get('extensionEnablementService').setEnablement([extension], 13);
      await h.get('storageService').flush();
    })()`)
    await reload()
    await ready()
    assert.equal(await disabled(), true, 'host global choice is still disabled')
    assert.equal(
      await run(
        `JSON.parse(adeHandle.get('storageService').get('extensionsIdentifiers/enabled', 1, '[]')).some(e => e.id === 'ade-test.enablement')`,
      ),
      true,
      'workspace enable override survives',
    )
    await wait(
      async () => (await activations()) > beforeDisabledReload,
      'workspace override allows activation',
    )

    const editor = BrowserWindow.getAllWindows().find(
      (window) => window !== picker,
    )
    const shell = (script) => editor.webContents.executeJavaScript(script)
    await setHost('invalid')
    const beforeFailure = await activations()
    await reload()
    await wait(
      () =>
        shell(
          'document.querySelector("[role=alert]")?.textContent.includes("Unable to load host extension enablement") && !!document.querySelector("button")',
        ),
      'retryable startup error',
    )
    assert.equal(
      await run('adeHandle.workbenchReady'),
      false,
      'workbench never starts with an invalid snapshot',
    )
    assert.equal(await activations(), beforeFailure)
    await setHost('disable')
    const failedPage = page
    const serverUrl = page.getURL()
    await shell('document.querySelector("button").click()')
    await wait(
      () => failedPage.isDestroyed() && pages().length === 1,
      'Retry replaces the failed page',
    )
    page = pages()[0]
    assert.equal(
      page.getURL(),
      serverUrl,
      'Retry reuses the running server route',
    )
    await ready()
    await wait(
      async () => !(await shell('!!document.querySelector("[role=alert]")')),
      'startup error cleared',
    )
    console.log(
      'PASS startup activation, re-enabling, session-local changes, workspace overrides, and retry',
    )
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
