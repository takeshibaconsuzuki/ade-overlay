import { app, BrowserWindow, webContents, dialog } from 'electron'
import assert from 'node:assert/strict'
import { access, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const directory = process.env.ADE_LIFECYCLE_DATA
const worktree = process.env.ADE_LIFECYCLE_WORKTREE
app.setPath('userData', join(directory, 'electron-data'))
let response = 0
let confirmations = 0
// Keep the real IPC path, while answering the native confirmation deterministically.
dialog.showMessageBox = async (options) => {
  assert.match(options.message, /Delete worktree linked/)
  assert.equal(options.defaultId, 0)
  confirmations++
  return { response, checkboxChecked: false }
}
await import('./index.js')
const wait = async (condition, label) => {
  const deadline = Date.now() + 20000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(50)
  }
}
const pages = () =>
  webContents
    .getAllWebContents()
    .filter((page) => /^http:.*\/vscode\//.test(page.getURL()))
void app.whenReady().then(async () => {
  try {
    await wait(() => BrowserWindow.getAllWindows().length === 1, 'picker')
    const picker = BrowserWindow.getAllWindows()[0]
    const run = (script) => picker.webContents.executeJavaScript(script)
    const row = `[...document.querySelectorAll(".worktree-row")].find(row => row.querySelector(".worktree-open").title === ${JSON.stringify(worktree)})`
    await wait(
      async () =>
        !picker.webContents.isLoading() &&
        (await run('document.querySelectorAll(".worktree-row").length === 2')),
      'worktrees',
    )
    const menuItem = async (label, action = 'disabled', target = row) => {
      picker.show()
      await run(
        `${target}.querySelector('.worktree-actions button').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))`,
      )
      const item = `[...document.querySelectorAll('[role=menu][data-state=open] [role=menuitem]')].find(item => item.textContent === ${JSON.stringify(label)})`
      await wait(() => run(`!!(${item})`), 'actions menu')
      const disabled = await run(
        `${item}.getAttribute('aria-disabled') === 'true'`,
      )
      if (action === 'click') {
        assert.equal(disabled, false, `${label} is available`)
        await run(`${item}.click()`)
      }
      if (
        await run(`!!document.querySelector('[role=menu][data-state=open]')`)
      ) {
        await run(
          `document.querySelector('[role=menu][data-state=open]').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`,
        )
      }
      await wait(
        () => run(`!document.querySelector('[role=menu][data-state=open]')`),
        'actions menu closed',
      )
      return disabled
    }
    assert.equal(
      await menuItem(
        'Delete worktree',
        'disabled',
        '[...document.querySelectorAll(".worktree-row")].find(row => row.querySelector(".worktree-open").title.endsWith("main"))',
      ),
      true,
      'main worktree cannot be deleted',
    )
    const open = async () => {
      await run(`${row}.querySelector('.worktree-open').click()`)
      await wait(() => pages().length === 1, 'editor page')
      const page = pages()[0]
      await wait(
        async () =>
          !page.isLoading() &&
          (await page.executeJavaScript('globalThis.adeTest?.workbenchReady')),
        'workbench ready',
      )
      return page
    }
    assert.equal(
      await run('document.documentElement.scrollWidth <= window.innerWidth'),
      true,
      'picker actions fit the window',
    )
    const command = (page, id, ...args) =>
      page.executeJavaScript(
        `adeTest.get("commandService").executeCommand(${[id, ...args].map((value) => JSON.stringify(value)).join(',')})`,
      )
    const marker = 'UNSAVED-LIFECYCLE-'
    const restored = (page) =>
      wait(
        () =>
          page.executeJavaScript(
            `document.body.innerText.includes(${JSON.stringify(marker)})`,
          ),
        'unsaved text restored after server stop',
      )
    const first = await open()
    await command(first, 'workbench.action.files.newUntitledFile')
    await command(first, 'type', { text: marker })
    await restored(first)
    const firstUrl = first.getURL()
    const firstId = first.id
    assert.equal(
      (await fetch(`${process.env.ADE_LIFECYCLE_CONTROL}/fail-stop`)).status,
      200,
    )
    await menuItem('Stop', 'click')
    await wait(
      async () =>
        await run(
          `!!${row}.querySelector('.worktree-status[aria-label^=Error]')`,
        ),
      'failed termination leaves Stop available',
    )
    assert.equal(
      pages().length,
      1,
      'the page remains until termination succeeds',
    )
    assert.equal(
      await run(`${row}.querySelector('.worktree-open').disabled`),
      true,
    )
    assert.equal(await menuItem('Stop'), false)
    assert.equal(await menuItem('Delete worktree'), true)
    await menuItem('Dismiss error', 'click')
    await wait(
      async () =>
        await run(
          `!!${row}.querySelector('.worktree-status[aria-label="VS Code Server stopping"]')`,
        ),
      'Stop is disabled while stopping without an error',
    )
    assert.equal(await menuItem('Stop'), true)
    // A fresh failure from another client enables the same retry action here.
    assert.equal((await fetch(process.env.ADE_LIFECYCLE_CONTROL)).status, 200)
    await wait(
      async () =>
        await run(
          `!!${row}.querySelector('.worktree-status[aria-label^=Error]')`,
        ),
      'worktree error enables Stop retry',
    )
    assert.equal(
      (await fetch(`${process.env.ADE_LIFECYCLE_CONTROL}/allow-stop`)).status,
      200,
    )
    await menuItem('Stop', 'click')
    await wait(
      async () =>
        pages().length === 0 &&
        (await run(
          `!!${row}.querySelector('.worktree-status[aria-label^=Error]') && !${row}.querySelector('.worktree-open').disabled`,
        )),
      'stopped and disposed',
    )
    await menuItem('Dismiss error', 'click')
    await wait(
      async () =>
        await run(
          `!!${row}.querySelector('.worktree-status[aria-label="VS Code Server stopped"]')`,
        ),
      'recovered error explicitly dismissed',
    )
    await access(worktree)
    assert.equal(
      (await fetch(firstUrl)).status,
      503,
      'stopped route has no upstream',
    )
    console.log(
      'PASS retried failed termination through picker and disposed page',
    )
    const second = await open()
    assert.notEqual(second.id, firstId, 'restart creates a new editor page')
    await restored(second)
    // This desktop does not initiate the stop; only the server broadcast disposes its page.
    assert.equal((await fetch(process.env.ADE_LIFECYCLE_CONTROL)).status, 200)
    await wait(() => pages().length === 0, 'remote stop disposed page')
    const third = await open()
    assert.notEqual(third.id, second.id)
    await restored(third)
    console.log('PASS local and remote stops preserve unsaved text')
    await run(`window.picker.deleteWorktree(${JSON.stringify(worktree)})`)
    assert.equal(confirmations, 1)
    assert.equal(pages().length, 1, 'cancel leaves the editor running')
    await access(worktree)
    response = 1
    const dirty = join(worktree, 'untracked.txt')
    await writeFile(dirty, 'keep me')
    await run(`window.picker.deleteWorktree(${JSON.stringify(worktree)})`)
    await wait(
      async () =>
        pages().length === 0 &&
        (await run(
          `!!${row}.querySelector('.worktree-status[aria-label^=Error]') && !${row}.querySelector('.worktree-open').disabled`,
        )),
      'asynchronous deletion failure displayed and row usable again',
    )
    await access(dirty)
    assert.equal(
      await run(
        '[...document.querySelectorAll(".worktree-row")].find(row => row.querySelector(".worktree-open").title.endsWith("main")).querySelector(".worktree-open").disabled',
      ),
      false,
      'another worktree remains available',
    )
    await menuItem('Dismiss error', 'click')
    await wait(
      async () =>
        await run(
          `!${row}.querySelector('.worktree-status[aria-label^=Error]')`,
        ),
      'deletion error dismissed',
    )
    await rm(dirty)
    await run(`window.picker.deleteWorktree(${JSON.stringify(worktree)})`)
    await wait(
      async () =>
        pages().length === 0 &&
        (await run('document.querySelectorAll(".worktree-row").length === 1')),
      'deleted worktree',
    )
    await assert.rejects(access(worktree), { code: 'ENOENT' })
    assert.equal(confirmations, 3)
    const shell = BrowserWindow.getAllWindows().find(
      (window) => window !== picker,
    )
    await wait(
      () =>
        shell.webContents.executeJavaScript(
          'document.body.innerText.includes("This worktree has been removed.") && !document.querySelector("button")',
        ),
      'removed editor has no retry',
    )
    await run('window.picker.refreshWorktrees()')
    assert.equal(
      await run('document.querySelectorAll(".worktree-row").length'),
      1,
    )
    console.log(
      'PASS picker stop, restart, cancelled deletion, deletion failure and confirmed deletion',
    )
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
