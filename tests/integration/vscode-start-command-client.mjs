import { app, BrowserWindow, globalShortcut } from 'electron'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { stringify } from 'yaml'

const directory = process.env.ADE_START_COMMAND_DATA
app.setPath('userData', join(directory, 'electron-data'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
let togglePicker
globalShortcut.register = (_shortcut, listener) => {
  togglePicker = listener
  return true
}
let allowConnection = false
let failedAttempts = 0
const server = new WebSocketServer({
  port: 0,
  host: '127.0.0.1',
  verifyClient: () => {
    if (!allowConnection) failedAttempts++
    return allowConnection
  },
})
await new Promise((resolve) => server.once('listening', resolve))
process.env.ADE_SERVER_URL = 'ws://127.0.0.1:' + server.address().port + '/rpc'
const script = join(directory, 'interactive.cjs')
const pidsFile = join(directory, 'pids')
await writeFile(
  script,
  `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(20);
process.stdin.setRawMode(true);
process.stdout.write('Password: ');
process.stdin.on('data', data => {
  fs.appendFileSync(${JSON.stringify(join(directory, 'input'))}, data.toString('hex') + '\\n');
  process.stdout.write('Received input\\r\\n');
  process.stdout.write('size=' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');
});
`,
)
await mkdir(join(directory, '.ade-overlay'))
await writeFile(
  join(directory, '.ade-overlay', 'desktop.config.yaml'),
  stringify({
    startCommand:
      '"' + process.env.ADE_START_COMMAND_NODE + '" "' + script + '"',
  }),
)
await import('./index.js')

const wait = async (condition, label) => {
  const deadline = Date.now() + 20_000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + label)
    await delay(25)
  }
}
const pids = async () =>
  (await readFile(pidsFile, 'utf8')).trim().split('\n').map(Number)
let exitCode = 1
app.once('will-quit', () => {
  server.close()
  app.exit(exitCode)
})
void app.whenReady().then(async () => {
  try {
    await wait(
      () => BrowserWindow.getAllWindows().length === 1,
      'picker window',
    )
    const picker = BrowserWindow.getAllWindows()[0]
    picker.webContents.removeAllListeners('blur')
    const run = (script) => picker.webContents.executeJavaScript(script)
    const screen = () =>
      run('document.querySelector(".xterm-rows")?.textContent ?? ""')
    await wait(
      async () =>
        !picker.webContents.isLoading() &&
        (await screen()).includes('Password:'),
      'interactive prompt',
    )
    assert.equal(
      await run('document.querySelector(".start-command-terminal").hidden'),
      false,
    )
    assert.equal(
      await run('document.querySelector(".rt-Spinner") === null'),
      true,
    )
    await wait(
      () =>
        run(
          'document.activeElement.classList.contains("xterm-helper-textarea")',
        ),
      'terminal focused',
    )
    const firstPid = (await pids())[0]
    await wait(() => failedAttempts >= 2, 'failed connection retries')
    assert.deepEqual(
      await pids(),
      [firstPid],
      'connection attempts do not restart the command',
    )

    // Exercise actual renderer keyboard handling, including keys used by the picker.
    await picker.webContents.insertText('secret')
    for (const keyCode of ['Up', 'Escape']) {
      picker.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      picker.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    picker.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'c',
      modifiers: ['control'],
    })
    picker.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'c',
      modifiers: ['control'],
    })
    await wait(async () => {
      const input = await readFile(join(directory, 'input'), 'utf8').catch(
        () => '',
      )
      const bytes = input.replaceAll('\n', '')
      return (
        bytes.includes('736563726574') &&
        bytes.includes('1b5b41') &&
        bytes.includes('1b') &&
        bytes.includes('03')
      )
    }, 'terminal receives text, arrows, Escape and Ctrl+C')
    assert.deepEqual(await pids(), [firstPid])

    const beforeResize = (await screen()).match(/size=\d+x\d+/g).at(-1)
    picker.setSize(750, 480)
    await delay(100)
    await picker.webContents.insertText('resize')
    await wait(
      async () =>
        (await screen()).match(/size=\d+x\d+/g).at(-1) !== beforeResize,
      'resized output',
    )

    togglePicker()
    await wait(() => run('document.hidden'), 'picker hidden')
    togglePicker()
    await wait(
      () =>
        run(
          '!document.hidden && document.activeElement.classList.contains("xterm-helper-textarea")',
        ),
      'terminal focused again',
    )
    assert.deepEqual(
      await pids(),
      [firstPid],
      'hiding the picker preserves the command',
    )
    assert.match(await screen(), /Password:/)

    picker.reload()
    await wait(
      async () =>
        !picker.webContents.isLoading() &&
        (await screen()).includes('Password:'),
      'output replayed after renderer reload',
    )
    assert.deepEqual(
      await pids(),
      [firstPid],
      'renderer reload preserves the command',
    )

    allowConnection = true
    await wait(
      () => run('document.body.innerText.includes("No worktrees found.")'),
      'connected picker',
    )
    assert.deepEqual(
      await pids(),
      [firstPid],
      'connecting preserves the command',
    )
    assert.doesNotThrow(() => process.kill(firstPid, 0))
    await wait(
      () =>
        run(
          'document.activeElement === document.querySelector(".worktree-search input")',
        ),
      'search focused',
    )

    allowConnection = false
    for (const client of server.clients) client.terminate()
    await wait(
      async () => (await pids()).length === 2,
      'command restarted after disconnect',
    )
    assert.throws(() => process.kill(firstPid, 0))
    await wait(
      () =>
        run(
          '!document.querySelector(".start-command-terminal").hidden && document.activeElement.classList.contains("xterm-helper-textarea")',
        ),
      'terminal restored',
    )
    await wait(
      async () => /Exited with (signal|code)/.test(await screen()),
      'exit status retained',
    )
    await writeFile(
      join('out', 'start-command-terminal.png'),
      (await picker.webContents.capturePage()).toPNG(),
    )
    console.log(
      'PASS interactive start command, connection transitions, visibility and focus',
    )
    exitCode = 0
  } catch (error) {
    console.error(error)
  } finally {
    app.quit()
  }
})
