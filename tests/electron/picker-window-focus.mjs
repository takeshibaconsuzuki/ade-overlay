import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import koffi from 'koffi'

const input = JSON.parse(readFileSync(process.env.ADE_FOCUS_TEST_INPUT, 'utf8'))
const isTarget = process.env.ADE_FOCUS_TEST_TARGET === '1'
app.setPath('userData', join(input.root, isTarget ? 'target' : 'picker'))
app.on('window-all-closed', () => {})
const handle = (window) => window.getNativeWindowHandle().readBigUInt64LE()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let stage = 'starting'
let child
let window
const deadline = setTimeout(() => {
  if (!isTarget)
    writeFileSync(input.result, JSON.stringify({ ok: false, stage }))
  child?.kill()
  app.exit(1)
}, 20_000)

async function target() {
  const user32 = koffi.load('user32.dll')
  const allow = user32.func(
    'int __stdcall AllowSetForegroundWindow(uint32_t process)',
  )
  const windows = [0, 1].map(
    (index) =>
      new BrowserWindow({
        show: false,
        width: 300,
        height: 200,
        title: `ADE focus test target ${index}`,
      }),
  )
  await Promise.all(
    windows.map((item) =>
      item.loadURL('data:text/html,<input autofocus value="Focus test">'),
    ),
  )
  process.on('message', ({ action, index }) => {
    if (action === 'focus') {
      windows[index].show()
      windows[index].focus()
    } else if (action === 'close') windows[index].destroy()
    else if (action === 'quit') app.exit(0)
    // The test has no physical hotkey input. Grant the initiating process the
    // foreground permission that a real shortcut invocation receives.
    allow(process.ppid)
    process.send({ done: true })
  })
  process.send({ handles: windows.map((item) => handle(item).toString()) })
}

async function run() {
  const user32 = koffi.load('user32.dll')
  const foreground = user32.func('void * __stdcall GetForegroundWindow()')
  const allow = user32.func(
    'int __stdcall AllowSetForegroundWindow(uint32_t process)',
  )
  const { PickerWindow } = await import(pathToFileURL(input.pickerModule).href)
  const { createWindowFocus } = await import(
    pathToFileURL(input.focusModule).href
  )
  window = new BrowserWindow({
    show: false,
    width: 300,
    height: 200,
    title: 'ADE focus test picker',
  })
  const picker = new PickerWindow(window, createWindowFocus(window))
  await window.loadURL('data:text/html,<input autofocus value="Picker test">')
  const own = handle(window)
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      if (check()) return
      await delay(20)
    }
    throw new Error(
      `Timed out: ${stage}; picker focused=${window.isFocused()}, visible=${window.isVisible()}, foreground is picker=${foreground() === own}`,
    )
  }
  picker.show()
  await until(() => foreground() === own && window.isFocused())
  child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ADE_FOCUS_TEST_TARGET: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: false,
  })
  const [ready] = await once(child, 'message')
  const [first, second] = ready.handles.map(BigInt)
  async function command(action, index) {
    allow(child.pid)
    const done = once(child, 'message')
    child.send({ action, index })
    await done
  }
  stage = 'restoring the first external window'
  await command('focus', 0)
  await until(() => foreground() === first && !window.isVisible())
  picker.show()
  await until(() => foreground() === own && window.isFocused())
  picker.hide()
  await until(() => foreground() === first)
  assert.equal(window.isVisible(), false)

  stage = 'a later visit captures a different external window'
  await command('focus', 1)
  await until(() => foreground() === second)
  picker.toggle()
  await until(() => foreground() === own && window.isFocused())
  picker.toggle()
  await until(() => foreground() === second)

  stage = 'focus loss preserves a newly chosen window'
  picker.show()
  await until(() => foreground() === own && window.isFocused())
  await command('focus', 0)
  await until(() => foreground() === first && !window.isVisible())
  await delay(100)
  assert.equal(foreground(), first)

  stage = 'a closed target does not prevent dismissal'
  picker.show()
  await until(() => foreground() === own && window.isFocused())
  await command('close', 0)
  picker.hide()
  assert.equal(window.isVisible(), false)
  window.destroy()
  const exited = once(child, 'exit')
  child.send({ action: 'quit' })
  await exited
}

app
  .whenReady()
  .then(isTarget ? target : run)
  .then(() => {
    if (isTarget) return
    writeFileSync(input.result, JSON.stringify({ ok: true }))
    clearTimeout(deadline)
    app.exit(0)
  })
  .catch((error) => {
    if (!isTarget)
      writeFileSync(
        input.result,
        JSON.stringify({ ok: false, stage, error: error.stack }),
      )
    child?.kill()
    window?.destroy()
    app.exit(1)
  })
