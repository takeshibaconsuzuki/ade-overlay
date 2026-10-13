import { app, BrowserWindow, webContents } from 'electron'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const directory = process.env.ADE_SETTINGS_TEST_DATA
const settingsFile = join(directory, 'settings.json')
app.setPath('userData', join(directory, 'electron-data'))
await import('./index.js')
const wait = async (condition, label) => {
  const deadline = Date.now() + 30000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(50)
  }
}
const pages = () =>
  webContents
    .getAllWebContents()
    .filter((page) => /^http:.*\/vscode\//.test(page.getURL()))
const readSettings = (page) =>
  page.executeJavaScript(`(async () => {
  if (!globalThis.adeHandle?.workbenchReady) return null;
  const handle = adeHandle;
  const resource = handle.get('IUserDataProfilesService').defaultProfile.settingsResource;
  if (!await handle.get('fileService').exists(resource)) return null;
  return (await handle.get('textFileService').read(resource)).value;
})()`)
const writeSettings = (page, content) =>
  page.executeJavaScript(`(async () => {
  const handle = adeHandle;
  await handle.get('textFileService').write(handle.get('IUserDataProfilesService').defaultProfile.settingsResource, ${JSON.stringify(content)});
})()`)

void app.whenReady().then(async () => {
  try {
    await wait(() => BrowserWindow.getAllWindows().length === 1, 'picker')
    const picker = BrowserWindow.getAllWindows()[0]
    await wait(
      async () =>
        !picker.webContents.isLoading() &&
        (await picker.webContents.executeJavaScript(
          'document.querySelectorAll(".worktree-open").length === 2',
        )),
      'two worktrees',
    )
    assert.equal(
      await picker.webContents.executeJavaScript(
        'typeof window.picker.openWorktree === "function" && typeof window.editor === "undefined"',
      ),
      true,
      'picker exposes only its own API',
    )
    for (let i = 0; i < 2; i++) {
      const previous = new Set(pages().map((page) => page.id))
      await picker.webContents.executeJavaScript(
        `document.querySelectorAll('.worktree-open')[${i}].click()`,
      )
      await wait(() => pages().length === i + 1, 'editor created')
      const page = pages().find((page) => !previous.has(page.id))
      await wait(
        async () =>
          !page.isLoading() &&
          (await page.executeJavaScript(
            '!!globalThis.adeHandle?.vscodeSettings?.apply',
          )),
        'settings bridge',
      )
    }
    const shell = BrowserWindow.getAllWindows().find(
      (window) => window !== picker,
    )
    await wait(
      async () =>
        !shell.webContents.isLoading() &&
        (await shell.webContents.executeJavaScript(
          '!!document.querySelector(".connection-screen") && typeof window.editor?.retryEditor === "function"',
        )),
      'editor shell renderer and preload',
    )
    assert.equal(
      await shell.webContents.executeJavaScript('typeof window.picker'),
      'undefined',
      'editor shell does not expose the picker API',
    )
    assert.equal(new URL(shell.webContents.getURL()).hash, '')
    const [a, b] = pages()
    const initial = await readFile(settingsFile, 'utf8')
    await wait(
      async () =>
        (await readSettings(a)) === initial &&
        (await readSettings(b)) === initial,
      'initial host document',
    )
    for (const page of [a, b]) {
      assert.deepEqual(
        await page.executeJavaScript(`({
          apply: typeof adeHandle.vscodeSettings.apply,
          changed: typeof adeHandle.vscodeSettings.changed,
          globals: Object.getOwnPropertyNames(globalThis).filter(name => /^ade/i.test(name)).sort(),
          picker: typeof window.picker,
          editor: typeof window.editor,
        })`),
        {
          apply: 'function',
          changed: 'function',
          globals: ['adeHandle'],
          picker: 'undefined',
          editor: 'undefined',
        },
        'all ADE workbench APIs are accessed through the handle',
      )
    }
    console.log('PASS initial host settings in both workbenches')
    for (const page of [a, b]) {
      await page.executeJavaScript(
        `(async () => {
          const h = adeHandle;
          const trust = h.get('workspaceTrustManagementService');
          await trust.workspaceTrustInitialized;
          await h.get('extensionService').whenInstalledExtensionsRegistered();
          await trust.setWorkspaceTrust(true);
        })()`,
      )
      await wait(
        () =>
          page.executeJavaScript(
            'globalThis.adeHandle?.workbenchReady && adeHandle.get("extensionService").extensions.some(extension => extension.identifier.value === "ade-test.shared")',
          ),
        'shared host extension',
      )
      await wait(
        () =>
          page.executeJavaScript(
            '!!globalThis.adeHandle?.vscodeSettings?.apply && adeHandle.get("configurationService").getValue("editor.fontSize") === 17',
          ),
        'effective user settings',
      )
    }
    console.log('PASS shared extension in both workbenches')
    const edited =
      '{\n // edited in ADE\n "editor.fontSize": 19,\n "[typescript]": {"editor.tabSize": 3}\n}\n'
    await writeSettings(a, edited)
    await wait(
      async () =>
        (await readFile(settingsFile, 'utf8')) === edited &&
        (await readSettings(b)) === edited,
      'ADE to host and other worktree',
    )
    const replacement = '{"editor.fontSize":21}\n'
    await writeFile(settingsFile, replacement)
    await wait(
      async () =>
        (await readSettings(a)) === replacement &&
        (await readSettings(b)) === replacement,
      'host replacement and deletion',
    )
    await writeSettings(a, '{')
    await delay(300)
    assert.equal(
      await readFile(settingsFile, 'utf8'),
      replacement,
      'invalid ADE settings do not reach host',
    )
    await writeSettings(a, '{"editor.fontSize":22}')
    await wait(
      async () => (await readSettings(b)) === '{"editor.fontSize":22}',
      'valid ADE edit recovers',
    )
    await fetch(`${process.env.ADE_SETTINGS_TEST_URL}/test/disconnect`)
    await wait(
      () =>
        picker.webContents.executeJavaScript(
          'document.querySelectorAll(".worktree-open").length === 0',
        ),
      'ADE disconnected',
    )
    const ids = [a.id, b.id]
    await writeSettings(a, '{"editor.fontSize":99}')
    const hostAfterDisconnect =
      '{\n // host wins on reconnect\n "editor.fontSize":23\n}\n'
    await writeFile(settingsFile, hostAfterDisconnect)
    await delay(300)
    assert.equal(
      await readSettings(a),
      '{"editor.fontSize":99}',
      'editor remains usable while ADE is disconnected',
    )
    await fetch(`${process.env.ADE_SETTINGS_TEST_URL}/test/reconnect`)
    await wait(
      async () =>
        (await readSettings(a)) === hostAfterDisconnect &&
        (await readSettings(b)) === hostAfterDisconnect,
      'host wins in still-open editors',
    )
    assert.deepEqual(
      pages().map((page) => page.id),
      ids,
      'same editor pages survive reconnect',
    )
    await writeSettings(b, '{"editor.fontSize":24}')
    await wait(
      async () =>
        (await readFile(settingsFile, 'utf8')) === '{"editor.fontSize":24}' &&
        (await readSettings(a)) === '{"editor.fontSize":24}',
      'outgoing sync resumes',
    )
    const reloaded = new Promise((resolve) =>
      a.once('did-finish-load', resolve),
    )
    a.reload()
    await reloaded
    await wait(
      async () =>
        (await a.executeJavaScript(
          '!!globalThis.adeHandle?.vscodeSettings?.apply',
        )) && (await readSettings(a)) === '{"editor.fontSize":24}',
      'settings handle resumes after page reload',
    )
    await writeSettings(a, '{"editor.fontSize":25}')
    await wait(
      async () =>
        (await readFile(settingsFile, 'utf8')) === '{"editor.fontSize":25}' &&
        (await readSettings(b)) === '{"editor.fontSize":25}',
      'reloaded page can still synchronize edits',
    )
    console.log(
      'PASS shared extensions, full settings documents, invalid edits, reconnect and page reload with two workbenches',
    )
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
