import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const input = JSON.parse(
  readFileSync(process.env.ADE_PICKER_TEST_INPUT, 'utf8'),
)
app.setPath('userData', join(input.root, 'profile'))
let window
let stage = 'startup'
const opened = []
const worktree = (path, branch) => ({
  project: 'C:/demo',
  path,
  branch,
  head: 'abc',
  main: false,
  locked: false,
  prunable: false,
  editor: 'stopped',
})
let snapshot = {
  revision: 0,
  projects: ['C:/demo'],
  worktrees: [
    worktree('C:\\demo\\Alpha', 'main'),
    worktree('C:/parent-only/second', 'feature/SearchNeedle'),
    ...Array.from({ length: 40 }, (_, i) =>
      worktree(`C:/demo/worktree-${i}`, `dev/${i}`),
    ),
    worktree('C:/demo/detached', null),
  ],
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => window.webContents.executeJavaScript(code)
async function until(code) {
  const end = Date.now() + 5_000
  while (Date.now() < end) {
    if (await evaluate(code)) return
    await delay(25)
  }
  throw new Error(`Timed out at ${stage}: ${code}`)
}
async function key(keyCode) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  if (keyCode === 'ENTER')
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  await delay(40)
}
async function search(value) {
  await evaluate(`(() => {
    const field=document.querySelector('input[type=search]');field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});
    field.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await delay(40)
}
const state = () =>
  evaluate(`(() => {
  const list=document.querySelector('.worktree-list');
  const rows=[...list.querySelectorAll('li')];
  return {count:rows.length,scroll:document.querySelector('[data-radix-scroll-area-viewport]').scrollTop,index:rows.findIndex(row=>row.hasAttribute('data-highlighted')),
    highlightVisible:rows.some(row=>row.hasAttribute('data-highlighted')&&getComputedStyle(row).backgroundColor!=='rgba(0, 0, 0, 0)'),
    searchFocused:document.activeElement===document.querySelector('input[type=search]'),
    selected:rows.find(row=>row.hasAttribute('data-highlighted'))?.querySelector('button').dataset.worktreeKey};
})()`)
async function update(worktrees) {
  snapshot = { ...snapshot, revision: snapshot.revision + 1, worktrees }
  window.webContents.send('test:update', { change: 'refreshed', snapshot })
  await delay(80)
}
async function focusWindow(enabled) {
  await window.webContents.debugger.sendCommand(
    'Emulation.setFocusEmulationEnabled',
    { enabled },
  )
  await delay(60)
}
async function assertListAlignment() {
  const bounds = await evaluate(`(() => {
    const search = document.querySelector('.worktree-search').getBoundingClientRect();
    const row = document.querySelector('.worktree-list li').getBoundingClientRect();
    const viewport = document.querySelector('[data-radix-scroll-area-viewport]');
    return { searchLeft:search.left, searchRight:search.right, rowLeft:row.left, rowRight:row.right,
      width:viewport.clientWidth, scrollWidth:viewport.scrollWidth };
  })()`)
  assert.equal(bounds.rowLeft, bounds.searchLeft)
  assert.equal(bounds.rowRight, bounds.searchRight)
  assert.equal(bounds.scrollWidth, bounds.width, 'no horizontal overflow')
}
async function run() {
  await app.whenReady()
  ipcMain.handle('test:list', () => snapshot)
  ipcMain.handle('test:open', (_event, value) => {
    opened.push(value.path)
  })
  window = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: {
      preload: fileURLToPath(
        new URL('./worktree-picker-preload.mjs', import.meta.url),
      ),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
      offscreen: true,
    },
  })
  await window.loadFile(join(input.root, 'renderer/index.html'))
  await until("document.querySelectorAll('.worktree-open').length===43")
  window.webContents.debugger.attach('1.3')
  await focusWindow(true)
  assert.equal((await state()).searchFocused, true)
  assert.equal((await state()).index, 0)
  assert.equal((await state()).highlightVisible, true)
  await assertListAlignment()

  stage = 'case-insensitive basename and branch filtering'
  await search('ALpHa')
  assert.equal((await state()).count, 1)
  await assertListAlignment()
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:\\demo\\Alpha')
  await search('searchneedle')
  assert.equal((await state()).count, 1)
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:/parent-only/second')
  await search('parent-only')
  assert.equal(
    (await state()).count,
    0,
    'parent directory is not a search term',
  )
  const calls = opened.length
  await key('ENTER')
  assert.equal(
    opened.length,
    calls,
    'empty results must not open a stale worktree',
  )

  stage = 'scroll and selection reset while filtering'
  await search('worktree')
  window.setContentSize(320, 400)
  await delay(60)
  await assertListAlignment()
  window.setContentSize(900, 600)
  await delay(60)
  for (let i = 0; i < 12; i++) await key('DOWN')
  const before = await state()
  assert.equal(before.searchFocused, true, 'arrows must keep search focus')
  assert.ok(before.scroll > 0)
  assert.equal(before.index, 12)
  stage = 'editor progress does not reset results'
  await update(
    snapshot.worktrees.map((w) => ({
      ...w,
      editor: 'starting',
      editorDetail: 'Starting VS Code',
    })),
  )
  assert.deepEqual(await state(), before)
  stage = 'typing after arrow navigation continues filtering'
  await window.webContents.insertText('-1')
  await until(
    "document.querySelector('input[type=search]').value==='worktree-1'",
  )
  assert.equal((await state()).scroll, 0)
  assert.equal((await state()).index, 0)
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:/demo/worktree-1')

  stage = 'changed membership resets focused result before Enter'
  await key('DOWN')
  const selected = JSON.parse((await state()).selected)[1]
  await update(snapshot.worktrees.filter((w) => w.path !== selected))
  assert.equal((await state()).scroll, 0)
  assert.equal((await state()).searchFocused, true)
  assert.equal((await state()).index, 0)
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:/demo/worktree-1')

  stage = 'window reactivation focuses search and preserves query'
  await key('DOWN')
  await key('UP')
  assert.equal((await state()).searchFocused, true)
  await key('DOWN')
  await focusWindow(false)
  await focusWindow(true)
  assert.equal((await state()).searchFocused, true)
  assert.equal((await state()).index, 0)
  assert.equal((await state()).highlightVisible, true)
  assert.equal(
    await evaluate("document.querySelector('input[type=search]').value"),
    'worktree-1',
  )

  stage = 'window reactivation does not steal dialog focus'
  await evaluate("document.querySelectorAll('.toolbar button')[2].click()")
  await until("!!document.querySelector('[role=dialog] input')")
  await evaluate("document.querySelector('[role=dialog] input').focus()")
  await focusWindow(false)
  await focusWindow(true)
  assert.equal(
    await evaluate("!!document.activeElement.closest('[role=dialog]')"),
    true,
  )
  await key('DOWN')
  assert.equal(
    await evaluate("!!document.activeElement.closest('[role=dialog]')"),
    true,
  )
}
run()
  .then(() => writeFileSync(input.result, JSON.stringify({ ok: true })))
  .catch((error) => {
    writeFileSync(
      input.result,
      JSON.stringify({ ok: false, stage, error: error.stack }),
    )
    process.exitCode = 1
  })
  .finally(() => {
    window?.destroy()
    app.exit(process.exitCode ?? 0)
  })
