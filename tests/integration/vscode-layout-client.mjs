import { app, BrowserWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

app.setPath('userData', process.env.ADE_LAYOUT_DATA)
await import('./index.js')

const wait = async (condition, label) => {
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
    const pages = () =>
      webContents
        .getAllWebContents()
        .filter((page) => /^http:.*\/vscode\//.test(page.getURL()))
    await wait(() => pages().length === 1, 'editor')
    const page = pages()[0]
    const run = (script) => page.executeJavaScript(script)
    const ready = () =>
      wait(
        async () =>
          !page.isLoading() &&
          (await run(
            'globalThis.adeTest?.workbenchReady && adeTest.get("layoutService").isRestored()',
          )),
        'layout restored',
      )
    const sidebar = () =>
      run(
        'adeTest.get("paneCompositePartService").getActivePaneComposite(0)?.getId()',
      )
    const secondaryVisible = () =>
      run(
        'adeTest.get("layoutService").isVisible("workbench.parts.auxiliarybar")',
      )

    await ready()
    const phase = process.env.ADE_LAYOUT_PHASE
    if (phase !== 'initial') {
      assert.equal(
        await sidebar(),
        phase === 'restore-ade'
          ? 'workbench.view.extension.ade'
          : 'workbench.view.explorer',
        'selected sidebar survives a full desktop restart',
      )
      assert.equal(await secondaryVisible(), true)
      if (phase === 'restore-ade')
        await run(
          '(async () => { await adeTest.executeCommand("workbench.view.explorer"); })()',
        )
      console.log(`PASS saved layout after desktop restart: ${phase}`)
      app.quit()
      return
    }
    assert.equal(await sidebar(), 'workbench.view.extension.ade')
    assert.equal(await secondaryVisible(), false)
    assert.equal(
      await run('adeTest.get("layoutService").getSideBarPosition()'),
      0,
      'primary sidebar is on the left',
    )
    const setting = await run(
      `(() => {
        const { defaultValue, userLocalValue, userRemoteValue } = adeTest.get('configurationService').inspect('workbench.secondarySideBar.defaultVisibility');
        return { defaultValue, userLocalValue, userRemoteValue };
      })()`,
    )
    assert.equal(setting.defaultValue, 'hidden')
    assert.equal(setting.userLocalValue, undefined)
    assert.equal(setting.userRemoteValue, undefined)

    await run(
      '(async () => { await adeTest.executeCommand("workbench.view.explorer"); })()',
    )
    await run(
      'adeTest.get("layoutService").setPartHidden(false, "workbench.parts.auxiliarybar")',
    )
    assert.equal(await sidebar(), 'workbench.view.explorer')
    assert.equal(await secondaryVisible(), true)
    await run('adeTest.get("storageService").flush(1)')
    const loaded = new Promise((resolve) =>
      page.once('did-finish-load', resolve),
    )
    page.reload()
    await loaded
    await ready()
    assert.equal(await sidebar(), 'workbench.view.explorer')
    assert.equal(await secondaryVisible(), true)
    await run(
      '(async () => { await adeTest.executeCommand("workbench.view.extension.ade"); })()',
    )
    assert.equal(await sidebar(), 'workbench.view.extension.ade')
    console.log('PASS initial ADE layout and saved layout restoration')
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
