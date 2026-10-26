import { app, BrowserWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
app.setPath('userData', process.env.ADE_SESSION_DATA)
await import('./index.js')
const wait = async (condition, label) => {
  const end = Date.now() + 20000
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
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
      'worktrees',
    )
    await picker.webContents.executeJavaScript(
      'document.querySelector(".worktree-open").click()',
    )
    const pages = () =>
      webContents
        .getAllWebContents()
        .filter((c) => /^http:.*\/vscode\//.test(c.getURL()))
    await wait(() => pages().length === 1, 'editor page')
    const page = pages()[0]
    await wait(
      async () =>
        !page.isLoading() &&
        (await page.executeJavaScript('globalThis.adeTest?.workbenchReady')),
      'workbench API',
    )
    assert.equal(
      await page.executeJavaScript(`(async () => {
        const trust = adeTest.get('workspaceTrustManagementService');
        await trust.workspaceTrustInitialized;
        return trust.isWorkspaceTrusted();
      })()`),
      true,
      'worktree is trusted automatically on startup',
    )
    const command = async (id, ...args) => {
      console.log('COMMAND', id)
      return Promise.race([
        page.executeJavaScript(
          `globalThis.adeTest.get("commandService").executeCommand(${[id, ...args].map((value) => JSON.stringify(value)).join(',')})`,
        ),
        delay(12000).then(() => {
          throw new Error(`command timed out ${id}`)
        }),
      ])
    }
    const phase = process.env.ADE_SESSION_PHASE
    const repo = process.env.ADE_SESSION_REPO
    const markerPath = join(repo, `${phase}.txt`)
    const quotedMarker =
      "'" +
      markerPath.replaceAll(
        "'",
        process.platform === 'win32' ? "''" : "'\"'\"'",
      ) +
      "'"
    const terminalCommand =
      process.platform === 'win32'
        ? `${phase === 'save' ? "$adeScopeMarker='still-running'; " : ''}"$PID $adeScopeMarker" | Set-Content -LiteralPath ${quotedMarker}\r`
        : `${phase === 'save' ? 'adeScopeMarker=still-running; ' : ''}printf '%s %s\\n' "$$" "$adeScopeMarker" > ${quotedMarker}\r`
    if (phase === 'save') {
      await command('workbench.action.terminal.new')
      await delay(1500)
      await command('workbench.action.terminal.sendSequence', {
        text: terminalCommand,
      })
    } else {
      await command('workbench.action.terminal.focus')
      await delay(4000)
      assert.ok(
        await page.executeJavaScript(
          '[...document.querySelectorAll(".tab")].some(e => e.textContent === "hello.txt")',
        ),
        'file restored',
      )
      console.log(
        'RESTORED FILE AND TABS',
        await page.executeJavaScript(
          '[...document.querySelectorAll(".tab")].map(e => e.textContent)',
        ),
      )
      await command('workbench.action.terminal.sendSequence', {
        text: terminalCommand,
      })
    }
    await wait(async () => {
      try {
        return !!(await readFile(markerPath, 'utf8')).trim()
      } catch {
        return false
      }
    }, 'terminal marker')
    const marker = (await readFile(markerPath, 'utf8')).trim()
    console.log('TERMINAL', phase, marker)
    if (phase === 'restore') {
      assert.equal(
        marker,
        (await readFile(join(repo, 'save.txt'), 'utf8')).trim(),
        'same shell process and variable survive',
      )
      console.log('PASS same live terminal restored')
    } else {
      await command('vscode.open', {
        scheme: 'vscode-remote',
        authority: new URL(page.getURL()).host,
        path:
          (process.platform === 'win32' ? '/' : '') +
          join(repo, 'hello.txt').replaceAll('\\', '/'),
      })
      await wait(
        async () =>
          await page.executeJavaScript(
            '[...document.querySelectorAll(".tab")].some(e => e.textContent === "hello.txt")',
          ),
        'file opened',
      )
      await command('workbench.action.splitEditorRight')
      await wait(
        () =>
          page.executeJavaScript(`(() => {
            const groups = adeTest.get('editorGroupsService');
            const editor = adeTest.get('editorService').activeTextEditorControl;
            return groups.groups.length === 2 && editor?.hasTextFocus();
          })()`),
        'split editor focused',
      )
      await command('cursorMove', { to: 'down', by: 'line', value: 1 })
      await wait(
        async () =>
          await page.executeJavaScript(
            'document.getElementById("status.editor.selection")?.textContent.includes("Ln 2,")',
          ),
        'cursor position',
      )
      {
        await command('type', { text: 'UNSAVED-SCOPE-' })
        await wait(
          async () =>
            await page.executeJavaScript(
              'document.body.innerText.includes("UNSAVED-SCOPE-") && document.getElementById("status.editor.selection")?.textContent.includes("Col 15")',
            ),
          'unsaved edit applied',
        )
      }
    }
    const view = await page.executeJavaScript(
      '({tabs:[...document.querySelectorAll(".tab")].map(e=>e.textContent), selection:document.getElementById("status.editor.selection")?.textContent})',
    )
    console.log('VIEW', phase, view)
    if (phase === 'save')
      await writeFile(join(repo, 'view.json'), JSON.stringify(view))
    if (phase === 'restore')
      assert.ok(
        await page.executeJavaScript(
          'document.body.innerText.includes("UNSAVED-SCOPE-")',
        ),
        'unsaved text restored',
      )
    if (phase === 'restore')
      assert.deepEqual(
        view,
        JSON.parse(await readFile(join(repo, 'view.json'), 'utf8')),
        'editor groups and cursor restore',
      )
    // Exercise ADE's actual shutdown path immediately after the edit, before periodic backups.
    if (phase === 'restore') app.quit()
    else picker.close()
  } catch (error) {
    console.error(error)
    for (const page of webContents
      .getAllWebContents()
      .filter((c) => /^http:.*\/vscode\//.test(c.getURL()))) {
      console.log(
        'PAGE TEXT',
        await page.executeJavaScript('document.body.innerText'),
      )
    }
    app.exit(1)
  }
})
