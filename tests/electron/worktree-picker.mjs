import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const input = JSON.parse(
  readFileSync(process.env.ADE_PICKER_TEST_INPUT, 'utf8'),
)
app.setPath('userData', join(input.root, 'profile'))
let window
let stage = 'startup'
let hideRequests = 0
const opened = []
let holdOpen = false
let finishOpen
let holdMutation = false
const mutations = []
const creations = []
let failBranchLoad = false
const deletions = []
const stops = []
let holdTemplates = false
let templateRequests = 0
const templateLoads = []
const pathTemplates = () => ({
  pathStyle: 'posix',
  projects: [
    { mainWorktreePath: 'C:/demo' },
    {
      mainWorktreePath: 'C:/second',
      worktreePathTemplate:
        '{{ mainWorktreePath }}/{{ branchName | hash | slice: 0, 8 }}',
    },
    { mainWorktreePath: 'C:/invalid', worktreePathTemplate: '{{ unknown }}' },
  ],
})
const deferMutation = () =>
  new Promise((resolve, reject) => mutations.push({ resolve, reject }))
const worktree = (path, branch) => ({
  project: 'C:/demo',
  path,
  branch,

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
const companionState = () => ({
  status: { state: 'connected', url: 'ws://test.invalid/companion' },
  snapshot,
  loading: false,
  error: '',
})
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
  return {count:rows.length,scroll:document.querySelector('[data-ui-scroll-viewport]').scrollTop,index:rows.findIndex(row=>row.hasAttribute('data-highlighted')),
    highlightVisible:rows.some(row=>row.hasAttribute('data-highlighted')&&getComputedStyle(row).backgroundColor!=='rgba(0, 0, 0, 0)'),
    searchFocused:document.activeElement===document.querySelector('input[type=search]'),
    selected:rows.find(row=>row.hasAttribute('data-highlighted'))?.querySelector('button').dataset.pickerKey};
})()`)
async function update(worktrees) {
  snapshot = { ...snapshot, revision: snapshot.revision + 1, worktrees }
  window.webContents.send('test:update', companionState())
  await delay(80)
}
async function focusWindow(enabled) {
  await window.webContents.debugger.sendCommand(
    'Emulation.setFocusEmulationEnabled',
    { enabled },
  )
  await delay(60)
}
async function moveMouse(selector, firstEventOnly = false) {
  const point = await evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`)
  // Chromium derives pointer movement from the screen coordinates.
  // Entering the window starts with zero movement; follow it with a move.
  if (!firstEventOnly) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      x: point.x - 1,
      y: point.y,
      globalX: point.x - 1,
      globalY: point.y,
    })
    await delay(40)
  }
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    ...point,
    globalX: point.x,
    globalY: point.y,
  })
  await delay(40)
  return point
}
async function clickMouse(selector) {
  const point = await moveMouse(selector)
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...point,
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...point,
  })
  await delay(40)
}
async function openDeleteMenu(label = 'Delete worktree') {
  await clickMouse('.worktree-delete button')
  await until("!!document.querySelector('[role=menu]')")
  await evaluate(
    `[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent === ${JSON.stringify(label)}).click()`,
  )
  await until("!!document.querySelector('[role=dialog]')")
}
async function assertListAlignment() {
  const bounds = await evaluate(`(() => {
    const search = document.querySelector('.worktree-search').getBoundingClientRect();
    const row = document.querySelector('.worktree-list li').getBoundingClientRect();
    const viewport = document.querySelector('[data-ui-scroll-viewport]');
    return { searchLeft:search.left, searchRight:search.right, rowLeft:row.left, rowRight:row.right,
      width:viewport.clientWidth, scrollWidth:viewport.scrollWidth };
  })()`)
  assert.equal(bounds.rowLeft, bounds.searchLeft)
  assert.equal(bounds.rowRight, bounds.searchRight)
  assert.equal(bounds.scrollWidth, bounds.width, 'no horizontal overflow')
}
async function assertSelectionInView() {
  assert.equal(
    await evaluate(`(() => {
    const row = document.querySelector('.worktree-list li[data-highlighted]').getBoundingClientRect();
    const viewport = document.querySelector('[data-ui-scroll-viewport]').getBoundingClientRect();
    return row.top >= viewport.top && row.bottom <= viewport.bottom;
  })()`),
    true,
    'the Enter target must be within the visible scroll area',
  )
}
async function run() {
  await app.whenReady()
  ipcMain.handle('test:hide', () => {
    hideRequests++
    window.webContents.send('test:hidden')
  })
  ipcMain.handle('test:state', () => {
    // A pushed state can arrive before the initial IPC read finishes.
    window.webContents.send('test:update', {
      ...companionState(),
      error: 'Latest companion state',
    })
    return companionState()
  })
  ipcMain.handle('test:open', (_event, value) => {
    opened.push(value.path)
    if (holdOpen)
      return new Promise((resolve) => {
        finishOpen = resolve
      })
  })
  ipcMain.handle('test:create', async (_event, value) => {
    creations.push(value)
    if (holdMutation) return deferMutation()
    await update([
      ...snapshot.worktrees,
      {
        ...worktree(value.path, value.branch),
        operation: 'creating',
        missing: true,
      },
    ])
  })
  ipcMain.handle('test:path-templates', () => {
    templateRequests++
    if (holdTemplates)
      return new Promise((resolve, reject) =>
        templateLoads.push({ resolve, reject }),
      )
    return pathTemplates()
  })
  ipcMain.handle('test:branches', (_event, project) => {
    if (failBranchLoad) throw new Error('Branch loading failed')
    return project === 'C:/demo'
      ? [
          { name: 'main', local: true },
          { name: 'release/v1', local: true },
          { name: 'origin/feature/search', local: false },
        ]
      : [{ name: 'other-branch', local: true }]
  })
  ipcMain.handle('test:delete', async (_event, value) => {
    deletions.push(value)
    if (holdMutation) return deferMutation()
    await update(
      snapshot.worktrees.map((row) =>
        row.path === value.path
          ? {
              ...row,
              operation: 'deleting',
              deletionFailure: undefined,
              error: undefined,
            }
          : row,
      ),
    )
  })
  ipcMain.handle('test:stop', async (_event, value) => {
    stops.push(value.path)
    await update(
      snapshot.worktrees.map((row) =>
        row.path === value.path
          ? { ...row, editor: 'stopped', color: undefined }
          : row,
      ),
    )
  })
  ipcMain.handle('test:error', async (_event, value) => {
    await update(
      snapshot.worktrees.map((row) =>
        row.path === value.path ? { ...row, error: value.error } : row,
      ),
    )
  })
  window = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: {
      preload: fileURLToPath(
        new URL('../fixtures/worktree-picker-preload.mjs', import.meta.url),
      ),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
      offscreen: true,
    },
  })
  await window.loadFile(join(input.root, 'renderer/index.html'))
  await until("document.querySelectorAll('.worktree-open').length===43")
  await until("document.body.textContent.includes('Latest companion state')")
  stage = 'worktree name colors'
  const nameColor = () =>
    evaluate(
      "getComputedStyle(document.querySelector('.worktree-name > span')).color",
    )
  const grey = await nameColor()
  await update(
    snapshot.worktrees.map((row, index) =>
      index === 0 ? { ...row, editor: 'running', color: 'blue' } : row,
    ),
  )
  const blue = await nameColor()
  assert.notEqual(blue, grey, 'assigned color replaces grey')
  assert.notEqual(
    blue,
    await evaluate(
      "getComputedStyle(document.querySelector('.worktree-branch')).color",
    ),
  )
  await update(
    snapshot.worktrees.map((row, index) =>
      index === 0 ? { ...row, editor: 'stopped', color: undefined } : row,
    ),
  )
  assert.equal(await nameColor(), grey, 'closed names return to grey')

  await update(snapshot.worktrees)
  window.webContents.debugger.attach('1.3')
  await focusWindow(true)
  assert.equal((await state()).searchFocused, true)
  assert.equal((await state()).index, 0)
  assert.equal((await state()).highlightVisible, true)
  await assertListAlignment()

  stage = 'initial stationary pointer preserves keyboard selection'
  await moveMouse('.worktree-list li:nth-child(2) .worktree-open', true)
  assert.equal((await state()).index, 0)
  await moveMouse('.worktree-list li:nth-child(2) .worktree-open', true)
  assert.equal((await state()).index, 0)
  await moveMouse('.worktree-list li:nth-child(2) .worktree-open')
  assert.equal((await state()).index, 1)

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
  // Keep the focus scenarios independent of recency reordering on activation.
  await update(snapshot.worktrees.map((row) => ({ ...row, editor: 'stopped' })))
  assert.deepEqual(await state(), before)
  stage = 'window reactivation preserves scrolled selection'
  await focusWindow(false)
  await focusWindow(true)
  await moveMouse('.worktree-list li:nth-child(12) .worktree-open', true)
  assert.deepEqual(await state(), before)
  stage = 'focusing search from a result preserves scrolled selection'
  await evaluate(
    "document.querySelector('.worktree-list li[data-highlighted] .worktree-open').focus({preventScroll:true})",
  )
  await evaluate(
    "document.querySelector('input[type=search]').focus({preventScroll:true})",
  )
  assert.deepEqual(await state(), before)
  await key('DOWN')
  assert.equal((await state()).index, before.index + 1)
  assert.ok((await state()).scroll > 0)
  stage = 'mouse movement off rows preserves the Enter target'
  const keyboardSelection = await state()
  await moveMouse('.toolbar button')
  assert.deepEqual(await state(), keyboardSelection)
  await key('ENTER')
  assert.equal(opened.at(-1), JSON.parse(keyboardSelection.selected)[1])
  await moveMouse('.worktree-list li:nth-child(13) .worktree-open')
  const hovered = await state()
  assert.equal(hovered.index, 12)
  assert.equal(hovered.highlightVisible, true)
  await focusWindow(false)
  await focusWindow(true)
  await moveMouse('.worktree-list li:nth-child(12) .worktree-open', true)
  assert.deepEqual(await state(), hovered)
  await moveMouse('.worktree-list li:nth-child(13) .worktree-delete')
  assert.deepEqual(await state(), hovered)
  await moveMouse('.toolbar button')
  assert.deepEqual(await state(), hovered)
  window.webContents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 })
  await delay(40)
  assert.deepEqual(await state(), hovered)
  await key('ENTER')
  assert.equal(opened.at(-1), JSON.parse(hovered.selected)[1])
  stage = 'hover highlights without keyboard focus and clears on leaving'
  const openCount = opened.length
  await evaluate("document.querySelector('input[type=search]').blur()")
  assert.equal((await state()).highlightVisible, false)
  await moveMouse('.worktree-list li:nth-child(12) .worktree-open')
  assert.equal((await state()).highlightVisible, true)
  assert.equal((await state()).index, 11)
  await key('ENTER')
  assert.equal(opened.length, openCount)
  await moveMouse('.toolbar button')
  assert.equal((await state()).highlightVisible, false)
  for (const selector of [
    '.toolbar button',
    '.worktree-list li:nth-child(13) .worktree-delete button',
  ]) {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`,
    )
    assert.equal((await state()).highlightVisible, false)
    await moveMouse('.worktree-list li:nth-child(12) .worktree-open')
    assert.equal((await state()).highlightVisible, true)
    await moveMouse('.toolbar button')
    assert.equal((await state()).highlightVisible, false)
  }
  stage = 'hover also works while the window is inactive'
  await focusWindow(false)
  await moveMouse('.worktree-list li:nth-child(13) .worktree-open')
  assert.equal((await state()).highlightVisible, true)
  assert.equal((await state()).index, 12)
  window.webContents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 })
  await delay(40)
  assert.equal((await state()).highlightVisible, false)
  await focusWindow(true)
  await evaluate(
    "document.querySelector('input[type=search]').focus({preventScroll:true})",
  )
  assert.deepEqual(await state(), hovered)
  await evaluate(
    "document.querySelector('.worktree-list li[data-highlighted] .worktree-open').focus({preventScroll:true})",
  )
  assert.equal((await state()).highlightVisible, true)
  await key('ENTER')
  assert.equal(opened.length, openCount + 1)
  assert.equal(opened.at(-1), JSON.parse(hovered.selected)[1])
  await evaluate(
    "document.querySelector('input[type=search]').focus({preventScroll:true})",
  )
  assert.deepEqual(await state(), hovered)
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
  await search('worktree')
  for (let i = 0; i < 12; i++) await key('DOWN')
  assert.ok((await state()).scroll > 0)
  const selected = JSON.parse((await state()).selected)[1]
  await update(snapshot.worktrees.filter((w) => w.path !== selected))
  assert.equal((await state()).scroll, 0)
  assert.equal((await state()).searchFocused, true)
  assert.equal((await state()).index, 0)
  await assertSelectionInView()
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:/demo/worktree-0')

  stage = 'added membership resets scrolled selection into view'
  for (let i = 0; i < 12; i++) await key('DOWN')
  assert.ok((await state()).scroll > 0)
  await update([
    ...snapshot.worktrees,
    worktree('C:/demo/worktree-added', 'added'),
  ])
  assert.equal((await state()).scroll, 0)
  assert.equal((await state()).index, 0)
  await assertSelectionInView()
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:/demo/worktree-0')
  await search('worktree-1')

  stage = 'window reactivation focuses search and preserves query'
  await key('DOWN')
  await key('UP')
  assert.equal((await state()).searchFocused, true)
  await key('DOWN')
  const beforeReactivation = await state()
  await focusWindow(false)
  await focusWindow(true)
  assert.equal((await state()).searchFocused, true)
  assert.equal((await state()).index, beforeReactivation.index)
  assert.equal((await state()).scroll, beforeReactivation.scroll)
  assert.equal((await state()).highlightVisible, true)
  assert.equal(
    await evaluate("document.querySelector('input[type=search]').value"),
    'worktree-1',
  )

  stage = 'hiding the picker clears search and resets results'
  window.webContents.send('test:hidden')
  await until("document.querySelector('input[type=search]').value===''")
  assert.equal((await state()).count, snapshot.worktrees.length)
  assert.equal((await state()).index, 0)
  assert.equal((await state()).scroll, 0)

  stage = 'hiding with an empty search resets navigation on reactivation'
  for (let i = 0; i < 12; i++) await key('DOWN')
  assert.equal((await state()).index, 12)
  assert.ok((await state()).scroll > 0)
  await evaluate(
    "document.querySelector('.worktree-list li[data-highlighted] .worktree-open').focus({preventScroll:true})",
  )
  await focusWindow(false)
  window.webContents.send('test:hidden')
  await delay(60)
  await focusWindow(true)
  assert.equal((await state()).index, 0)
  assert.equal((await state()).scroll, 0)
  assert.equal((await state()).searchFocused, true)
  await assertSelectionInView()
  await key('ENTER')
  assert.equal(opened.at(-1), snapshot.worktrees[0].path)

  stage = 'Escape in search hides with either a nonempty or empty query'
  const hidesBeforeEscape = hideRequests
  await search('worktree-1')
  await key('ESCAPE')
  await until("document.querySelector('input[type=search]').value===''")
  assert.equal(hideRequests, hidesBeforeEscape + 1)
  for (let i = 0; i < 12; i++) await key('DOWN')
  assert.equal((await state()).index, 12)
  assert.ok((await state()).scroll > 0)
  await key('ESCAPE')
  assert.equal(hideRequests, hidesBeforeEscape + 2)
  assert.equal((await state()).index, 0)
  assert.equal((await state()).scroll, 0)

  stage = 'window reactivation does not steal dialog focus'
  const hidesBeforeDialog = hideRequests
  await evaluate("document.querySelectorAll('.toolbar button')[2].click()")
  await until("!!document.querySelector('[role=dialog] input')")
  await evaluate("document.querySelector('[role=dialog] input').focus()")
  assert.equal((await state()).highlightVisible, false)
  await focusWindow(false)
  await focusWindow(true)
  assert.equal(
    await evaluate("!!document.activeElement.closest('[role=dialog]')"),
    true,
  )
  assert.equal((await state()).highlightVisible, false)
  await key('DOWN')
  assert.equal(
    await evaluate("!!document.activeElement.closest('[role=dialog]')"),
    true,
  )
  await key('ESCAPE')
  await until("!document.querySelector('.ui-field-dropdown')")
  assert.equal(
    await evaluate("!!document.querySelector('[role=dialog]')"),
    true,
  )
  await key('ESCAPE')
  await until("!document.querySelector('[role=dialog]')")
  assert.equal(
    hideRequests,
    hidesBeforeDialog,
    'dialog Escape keeps the picker open',
  )

  stage = 'creation path autofill follows branches and respects manual paths'
  const openCreate = async () => {
    await evaluate(
      "[...document.querySelectorAll('button')].find(button => button.textContent === 'Create worktree').click()",
    )
    await until("!!document.querySelector('[role=dialog] input')")
  }
  const setCreateField = async (index, value) => {
    await evaluate(`(() => {
      const field = document.querySelectorAll('[role=dialog] input')[${index}];
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', {bubbles:true}));
    })()`)
  }
  const pathEquals = (value) =>
    `document.querySelectorAll('[role=dialog] input')[2]?.value === ${JSON.stringify(value)}`
  const closeCreate = async () => {
    await key('ESCAPE')
    await until("!document.querySelector('[role=dialog]')")
  }
  const waitTemplateLoad = async () => {
    const end = Date.now() + 5000
    while (!templateLoads.length && Date.now() < end) await delay(25)
    assert.ok(templateLoads.length, 'template request arrived')
    return templateLoads.shift()
  }
  const requestsBeforeOpen = templateRequests
  await openCreate()
  await until(pathEquals('C:/demo-HEAD'))
  assert.equal(templateRequests, requestsBeforeOpen + 1)
  await setCreateField(0, '')
  await window.webContents.insertText('ReLeAsE')
  await until(
    "document.querySelectorAll('.ui-field-dropdown [role=option]').length === 1",
  )
  assert.equal(
    await evaluate(
      "document.querySelector('.ui-field-dropdown [role=option]').textContent",
    ),
    'release/v1',
  )
  assert.equal(
    await evaluate(
      "document.activeElement === document.querySelector('input[role=combobox]')",
    ),
    true,
  )
  await key('ENTER')
  await until("!document.querySelector('.ui-field-dropdown')")
  await until(pathEquals('C:/demo-release-v1'))
  assert.equal(
    await evaluate(
      "document.querySelectorAll('[role=dialog] input')[1].required",
    ),
    false,
  )
  assert.equal(
    await evaluate("!!document.querySelector('[role=dialog]')"),
    true,
  )
  await setCreateField(0, '')
  await until(
    "document.querySelectorAll('.ui-field-dropdown [role=option]').length === 3",
  )
  await key('DOWN')
  await until(
    "document.querySelector('.ui-field-dropdown [aria-selected=true]')?.textContent === 'release/v1'",
  )
  await key('UP')
  await until(
    "document.querySelector('.ui-field-dropdown [aria-selected=true]')?.textContent === 'main'",
  )
  await moveMouse('.ui-field-dropdown li:first-child button')
  await moveMouse('.ui-field-dropdown li:last-child button')
  await until(
    "document.querySelector('.ui-field-dropdown [aria-selected=true]')?.textContent === 'origin/feature/search'",
  )
  await clickMouse('.ui-field-dropdown li:last-child button')
  await until(pathEquals('C:/demo-origin-feature-search'))
  assert.equal(
    await evaluate(
      "document.querySelectorAll('[role=dialog] input')[1].required",
    ),
    true,
  )
  await until("!document.querySelector('.ui-field-dropdown')")
  await setCreateField(1, 'manual-ref')
  await setCreateField(0, 'HEAD~1')
  await until(
    "document.querySelector('.ui-field-picker-empty')?.textContent === 'No results'",
  )
  const creationsBeforeNoResults = creations.length
  await key('ENTER')
  await until("!document.querySelector('.ui-field-dropdown')")
  assert.equal(creations.length, creationsBeforeNoResults)
  assert.equal(
    await evaluate("!!document.querySelector('[role=dialog]')"),
    true,
  )
  assert.equal(
    await evaluate("document.querySelector('input[role=combobox]').value"),
    'HEAD~1',
  )
  await key('DOWN')
  await until("!!document.querySelector('.ui-field-dropdown')")
  await key('TAB')
  await until("!document.querySelector('.ui-field-dropdown')")
  assert.equal(
    await evaluate(
      "document.activeElement === document.querySelectorAll('[role=dialog] input')[1]",
    ),
    true,
  )
  await setCreateField(0, 'release/v1')
  await setCreateField(1, '')
  await until(pathEquals('C:/demo-release-v1'))
  await setCreateField(1, 'feature/login')
  await until(pathEquals('C:/demo-feature-login'))
  await setCreateField(0, 'main')
  await until(pathEquals('C:/demo-feature-login'))
  await setCreateField(2, '../manual')
  await setCreateField(1, 'feature/next')
  await delay(50)
  assert.equal(await evaluate(pathEquals('../manual')), true)
  await setCreateField(2, '')
  await delay(50)
  assert.equal(await evaluate(pathEquals('')), true)
  await setCreateField(0, 'different-base')
  await delay(50)
  assert.equal(
    await evaluate(pathEquals('')),
    true,
    'unchanged effective branch leaves a cleared path empty',
  )
  await setCreateField(0, 'main')
  await setCreateField(1, ' ')
  await until(pathEquals('C:/demo-main'))

  stage = 'project switching and hashing use cached templates locally'
  snapshot.projects = ['C:/demo', 'C:/second', 'C:/invalid']
  await update(snapshot.worktrees)
  const selectCreateProject = async (project) => {
    await evaluate(
      "document.querySelector('[role=dialog] [role=combobox]').click()",
    )
    await until("!!document.querySelector('[role=option]')")
    await evaluate(
      `[...document.querySelectorAll('[role=option]')].find(option => option.textContent === ${JSON.stringify(project)}).click()`,
    )
  }
  await setCreateField(2, '../manual-again')
  await selectCreateProject('C:/second')
  await setCreateField(0, '')
  await until(
    "document.querySelector('.ui-field-dropdown [role=option]')?.textContent === 'other-branch'",
  )
  await key('ESCAPE')
  await until("!document.querySelector('.ui-field-dropdown')")
  assert.equal(await evaluate(pathEquals('../manual-again')), true)
  await setCreateField(2, '')
  await delay(50)
  assert.equal(await evaluate(pathEquals('')), true)
  await setCreateField(1, 'pending')
  const hash = createHash('sha256').update('pending').digest('hex').slice(0, 8)
  await until(pathEquals(`C:/second/${hash}`))
  await selectCreateProject('C:/demo')
  await until(pathEquals('C:/demo-pending'))
  assert.equal(
    templateRequests,
    requestsBeforeOpen + 1,
    'typing and project switching never request another template',
  )

  stage = 'local template failures allow manual entry'
  await selectCreateProject('C:/invalid')
  await until(
    "document.querySelector('[role=dialog]').textContent.includes('Invalid worktreePathTemplate')",
  )
  assert.equal(
    await evaluate(pathEquals('C:/demo-pending')),
    true,
    'failed rendering preserves the previous path',
  )
  await setCreateField(2, '../manual-fallback')
  await until(
    "!document.querySelector('[role=dialog]').textContent.includes('Invalid worktreePathTemplate')",
  )
  snapshot.projects = ['C:/demo']
  await update(snapshot.worktrees)
  await closeCreate()

  stage =
    'Enter accepts manual Git refs after branch loading fails without submitting'
  failBranchLoad = true
  await openCreate()
  await until(
    "document.querySelector('[role=dialog]').textContent.includes('Could not load branches')",
  )
  await setCreateField(1, 'manual-after-failure')
  await setCreateField(0, 'HEAD~1')
  await until(
    "document.querySelector('.ui-field-picker-empty')?.textContent === 'No results'",
  )
  const creationsBeforeFailure = creations.length
  await key('ENTER')
  await until("!document.querySelector('.ui-field-dropdown')")
  assert.equal(creations.length, creationsBeforeFailure)
  assert.equal(
    await evaluate("document.querySelector('input[role=combobox]').value"),
    'HEAD~1',
  )
  await closeCreate()
  failBranchLoad = false

  stage = 'template loading preserves manual paths and waits after clearing'
  holdTemplates = true
  await openCreate()
  const pendingTemplates = await waitTemplateLoad()
  await setCreateField(1, 'old')
  await setCreateField(2, '../manual-loading')
  pendingTemplates.resolve(pathTemplates())
  await delay(50)
  assert.equal(await evaluate(pathEquals('../manual-loading')), true)
  await setCreateField(2, '')
  await delay(50)
  assert.equal(await evaluate(pathEquals('')), true)
  await setCreateField(1, 'new')
  await until(pathEquals('C:/demo-new'))
  await closeCreate()

  await openCreate()
  const clearedTemplates = await waitTemplateLoad()
  await setCreateField(2, '../clear-me')
  await setCreateField(2, '')
  clearedTemplates.resolve(pathTemplates())
  await delay(50)
  assert.equal(
    await evaluate(pathEquals('')),
    true,
    'loading completion cannot refill a cleared path',
  )
  await setCreateField(1, 'after-clear')
  await until(pathEquals('C:/demo-after-clear'))
  await closeCreate()

  stage = 'dismissed template loads cannot change a reopened dialog'
  await openCreate()
  const dismissedTemplates = await waitTemplateLoad()
  await closeCreate()
  holdTemplates = false
  await openCreate()
  await until(pathEquals('C:/demo-HEAD'))
  dismissedTemplates.reject(new Error('Obsolete template failure'))
  await delay(50)
  assert.equal(await evaluate(pathEquals('C:/demo-HEAD')), true)
  assert.equal(
    await evaluate(
      "document.querySelector('[role=dialog]').textContent.includes('Obsolete template failure')",
    ),
    false,
  )
  await closeCreate()

  stage = 'dismissed submissions cannot mutate a reopened dialog'
  await search('')
  holdMutation = true
  for (const kind of ['create', 'delete']) {
    const reopen = async () => {
      if (kind === 'create') {
        await evaluate(
          "[...document.querySelectorAll('button')].find(button => button.textContent === 'Create worktree').click()",
        )
      } else {
        await openDeleteMenu()
      }
      await until("!!document.querySelector('[role=dialog]')")
      if (kind === 'create') {
        await evaluate(`(() => {
          const fields = document.querySelectorAll('[role=dialog] input');
          for (const [index, value] of [[0, 'main'], [2, 'C:/demo/race']]) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(fields[index], value);
            fields[index].dispatchEvent(new Event('input', {bubbles:true}));
          }
        })()`)
      }
    }
    const submit = async () => {
      await evaluate(
        kind === 'create'
          ? "document.querySelector('[role=dialog] form').requestSubmit()"
          : "[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Delete worktree').click()",
      )
      await until(
        "document.querySelector('[role=dialog] .dialog-actions button:last-child').disabled",
      )
    }
    const dismiss = async () => {
      await key('ESCAPE')
      await until("!document.querySelector('[role=dialog]')")
    }
    for (const failure of [false, true]) {
      await reopen()
      await submit()
      const old = mutations.shift()
      assert.ok(old)
      await dismiss()
      await reopen()
      await submit()
      const current = mutations.shift()
      assert.ok(current)
      if (failure) old.reject(new Error('Obsolete submission failed'))
      else old.resolve()
      await delay(80)
      assert.equal(
        await evaluate("!!document.querySelector('[role=dialog]')"),
        true,
      )
      assert.equal(
        await evaluate(
          "document.querySelector('[role=dialog] .dialog-actions button:last-child').disabled",
        ),
        true,
      )
      assert.equal(
        await evaluate(
          "document.querySelector('[role=dialog]').textContent.includes('Obsolete submission failed')",
        ),
        false,
      )
      current.resolve()
      await until("!document.querySelector('[role=dialog]')")
    }
  }
  holdMutation = false

  stage = 'creation closes its dialog while the pending row spins'
  await search('')
  await evaluate("document.querySelectorAll('.toolbar button')[2].click()")
  await until("!!document.querySelector('[role=dialog] input')")
  await evaluate(`(() => {
    const fields = document.querySelectorAll('[role=dialog] input');
    for (const [index, value] of [[1, 'pending-create'], [2, 'C:/demo/pending-create']]) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(fields[index], value);
      fields[index].dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`)
  await evaluate("document.querySelector('[role=dialog] form').requestSubmit()")
  await until("!document.querySelector('[role=dialog]')")
  await search('pending-create')
  assert.equal(
    await evaluate(
      "document.querySelector('.worktree-open').getAttribute('aria-busy')",
    ),
    'true',
  )
  assert.equal(
    await evaluate("document.querySelector('.worktree-open').disabled"),
    true,
  )

  stage = 'a fresh picker restores pending operation status'
  const reloaded = once(window.webContents, 'did-finish-load')
  window.reload()
  await reloaded
  await until("!!document.querySelector('.worktree-open')")
  await search('pending-create')
  assert.equal(
    await evaluate(
      "document.querySelector('.worktree-open').getAttribute('aria-busy')",
    ),
    'true',
  )

  stage = 'availability changes preserve a valid keyboard selection'
  await search('worktree')
  for (let i = 0; i < 12; i++) await key('DOWN')
  const beforeAvailability = await state()
  assert.ok(beforeAvailability.scroll > 0)
  const firstPath = snapshot.worktrees.find((row) =>
    row.path.includes('worktree-'),
  ).path
  await update(
    snapshot.worktrees.map((row) =>
      row.path === firstPath ? { ...row, operation: 'deleting' } : row,
    ),
  )
  assert.deepEqual(await state(), beforeAvailability)
  await update(
    snapshot.worktrees.map((row) =>
      row.path === firstPath ? { ...row, operation: undefined } : row,
    ),
  )
  assert.deepEqual(await state(), beforeAvailability)
  const selectedPath = JSON.parse(beforeAvailability.selected)[1]
  await update(
    snapshot.worktrees.map((row) =>
      row.path === selectedPath ? { ...row, operation: 'deleting' } : row,
    ),
  )
  assert.equal((await state()).index, 0)
  assert.equal((await state()).scroll, 0)
  await assertSelectionInView()
  await key('ENTER')
  assert.equal(opened.at(-1), firstPath)

  stage = 'selection reset reveals the first enabled row below disabled rows'
  const disabledPaths = snapshot.worktrees
    .filter((row) => row.path.includes('worktree-'))
    .slice(0, 20)
    .map((row) => row.path)
  await update(
    snapshot.worktrees.map((row) =>
      disabledPaths.includes(row.path)
        ? { ...row, operation: 'deleting' }
        : row,
    ),
  )
  assert.equal((await state()).index, 20)
  await assertSelectionInView()
  const enabledPath = JSON.parse((await state()).selected)[1]
  await key('ENTER')
  assert.equal(opened.at(-1), enabledPath)

  stage =
    'worktree menu owns keyboard focus and disables branch deletion for detached HEAD'
  await search('Alpha')
  const beforeMenuOpens = opened.length
  const beforeMenuHides = hideRequests
  await evaluate("document.querySelector('.worktree-delete button').focus()")
  await key('ENTER')
  await until("!!document.querySelector('[role=menu]')")
  assert.equal(
    await evaluate("!!document.activeElement.closest('[role=menu]')"),
    true,
  )
  await key('DOWN')
  assert.equal(
    await evaluate('document.activeElement.textContent'),
    'Delete worktree and branch',
  )
  await key('ESCAPE')
  await until("!document.querySelector('[role=menu]')")
  assert.equal(
    await evaluate(
      "document.activeElement === document.querySelector('.worktree-delete button')",
    ),
    true,
  )
  assert.equal(opened.length, beforeMenuOpens)
  assert.equal(hideRequests, beforeMenuHides)
  await search('detached')
  await clickMouse('.worktree-delete button')
  await until("!!document.querySelector('[role=menu]')")
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent === 'Delete worktree and branch').getAttribute('aria-disabled')",
    ),
    'true',
  )
  await key('ESCAPE')
  await until("!document.querySelector('[role=menu]')")

  stage =
    'main worktrees disable deletion and offer stopping a running VS Code server'
  const menuItems = () =>
    evaluate(
      "[...document.querySelectorAll('[role=menuitem]')].map(item => [item.textContent, item.getAttribute('aria-disabled') === 'true'])",
    )
  await search('detached')
  await clickMouse('.worktree-delete button')
  await until("!!document.querySelector('[role=menu]')")
  assert.deepEqual(await menuItems(), [
    ['Stop VS Code server', true],
    ['Delete worktree', false],
    ['Delete worktree and branch', true],
  ])
  await key('ESCAPE')
  await until("!document.querySelector('[role=menu]')")
  const mainPath = 'C:/demo/detached'
  await update(
    snapshot.worktrees.map((row) =>
      row.path === mainPath
        ? { ...row, main: true, editor: 'running', color: 'blue' }
        : row,
    ),
  )
  await update(
    snapshot.worktrees.map((row) =>
      row.path === mainPath
        ? { ...row, main: true, editor: 'starting', color: 'blue' }
        : row,
    ),
  )
  await clickMouse('.worktree-delete button')
  await until("!!document.querySelector('[role=menu]')")
  assert.deepEqual(await menuItems(), [
    ['Stop VS Code server', true],
    ['Delete worktree', true],
    ['Delete worktree and branch', true],
  ])
  await key('ESCAPE')
  await until("!document.querySelector('[role=menu]')")
  await update(
    snapshot.worktrees.map((row) =>
      row.path === mainPath ? { ...row, editor: 'running' } : row,
    ),
  )
  await clickMouse('.worktree-delete button')
  await until("!!document.querySelector('[role=menu]')")
  assert.deepEqual(await menuItems(), [
    ['Stop VS Code server', false],
    ['Delete worktree', true],
    ['Delete worktree and branch', true],
  ])
  await evaluate(
    "[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent === 'Stop VS Code server').click()",
  )
  await until("!document.querySelector('[role=menu]')")
  assert.deepEqual(stops, [mainPath])
  assert.equal(
    snapshot.worktrees.find((row) => row.path === mainPath).editor,
    'stopped',
  )
  assert.equal(opened.length, beforeMenuOpens)
  await update(
    snapshot.worktrees.map((row) =>
      row.path === mainPath ? { ...row, main: false } : row,
    ),
  )

  stage = 'deletion closes its dialog while the existing row spins'
  await search('Alpha')
  await openDeleteMenu()
  await until("!!document.querySelector('[role=dialog]')")
  await evaluate(
    "[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Delete worktree').click()",
  )
  await until("!document.querySelector('[role=dialog]')")
  assert.equal(
    await evaluate(
      "document.querySelector('.worktree-open').getAttribute('aria-busy')",
    ),
    'true',
  )
  assert.equal(
    await evaluate("document.querySelector('.worktree-open').disabled"),
    true,
  )

  stage = 'blocked deletion lists files and cancellation never forces removal'
  const blocked = {
    files: ['src/changed.ts', 'new file.txt', 'nested/未追跡.txt'],
    canForce: true,
    deleteBranch: false,
  }
  await update(
    snapshot.worktrees.map((row) =>
      row.branch === 'main'
        ? {
            ...row,
            operation: undefined,
            error: 'Git refused deletion: untracked files',
            deletionFailure: blocked,
          }
        : row,
    ),
  )
  await until("!!document.querySelector('[role=dialog]')")
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('.delete-files li')].map(item => item.textContent)",
    ),
    blocked.files,
  )
  const deletionCount = deletions.length
  const openedCount = opened.length
  await key('DOWN')
  assert.equal(
    await evaluate("!!document.activeElement.closest('[role=dialog]')"),
    true,
  )
  await key('ESCAPE')
  await until("!document.querySelector('[role=dialog]')")
  assert.equal(deletions.length, deletionCount)
  assert.equal(opened.length, openedCount)

  stage =
    'branch deletion preserves the action through explicit force confirmation'
  await openDeleteMenu('Delete worktree and branch')
  await evaluate(
    "[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Delete worktree and branch').click()",
  )
  await until("!document.querySelector('[role=dialog]')")
  assert.equal(deletions.at(-1).deleteBranch, true)
  assert.equal(deletions.at(-1).force, false)
  await update(
    snapshot.worktrees.map((row) =>
      row.branch === 'main'
        ? {
            ...row,
            operation: undefined,
            error: 'Git refused deletion: untracked files',
            deletionFailure: { ...blocked, deleteBranch: true },
          }
        : row,
    ),
  )
  await until("!!document.querySelector('[role=dialog]')")
  await evaluate(
    "[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Delete with --force').click()",
  )
  await until("!document.querySelector('[role=dialog]')")
  assert.equal(deletions.at(-1).deleteBranch, true)
  assert.equal(deletions.at(-1).force, true)

  stage = 'row failure tooltip and clearing without opening the editor'
  await update(
    snapshot.worktrees.map((row) =>
      row.branch === 'main'
        ? {
            ...row,
            editor: 'stopped',
            operation: undefined,
            error: 'Git refused deletion: untracked files',
          }
        : row,
    ),
  )
  await until("!!document.querySelector('.worktree-error')")
  assert.equal(
    await evaluate("document.querySelectorAll('[role=alert]').length"),
    0,
  )
  const alignment = await evaluate(`(() => {
    const icon = document.querySelector('.worktree-error svg').getBoundingClientRect();
    const status = document.querySelector('.editor-status').getBoundingClientRect();
    const row = document.querySelector('.worktree-entry').getBoundingClientRect();
    return { dx: icon.x + icon.width / 2 - status.x - status.width / 2,
      dy: icon.y + icon.height / 2 - status.y - status.height / 2,
      x: Math.round(row.x + row.width / 2), y: Math.round(row.y + row.height / 2) };
  })()`)
  assert.ok(
    Math.abs(alignment.dx) < 1 && Math.abs(alignment.dy) < 1,
    'X aligns with the status icon',
  )
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    x: alignment.x,
    y: alignment.y,
  })
  await until(
    "document.querySelector('[role=tooltip]')?.textContent.includes('Git refused deletion')",
  )
  holdOpen = true
  await evaluate("document.querySelector('.worktree-open').click()")
  await until(
    "document.querySelector('.worktree-open').getAttribute('aria-busy') === 'true'",
  )
  assert.equal(
    await evaluate("!!document.querySelector('.worktree-error')"),
    false,
    'opening spinner takes precedence over a retained error',
  )
  assert.equal(
    snapshot.worktrees.find((row) => row.branch === 'main').error,
    'Git refused deletion: untracked files',
  )
  finishOpen()
  holdOpen = false
  await until(
    "document.querySelector('.worktree-open').getAttribute('aria-busy') === 'false'",
  )
  assert.equal(
    await evaluate("!!document.querySelector('.worktree-error')"),
    true,
    'opening preserves the failure',
  )
  for (const [editor, operation] of [
    ['starting', undefined],
    ['running', 'creating'],
    ['running', 'deleting'],
  ]) {
    await update(
      snapshot.worktrees.map((row) =>
        row.branch === 'main' ? { ...row, editor, operation } : row,
      ),
    )
    assert.equal(
      await evaluate(
        "document.querySelector('.worktree-open').getAttribute('aria-busy')",
      ),
      'true',
    )
    assert.equal(
      await evaluate("!!document.querySelector('.worktree-error')"),
      false,
      'spinner takes precedence over error and running status',
    )
  }
  await update(
    snapshot.worktrees.map((row) =>
      row.branch === 'main'
        ? { ...row, editor: 'running', operation: undefined }
        : row,
    ),
  )
  assert.equal(
    await evaluate("!!document.querySelector('.worktree-error')"),
    true,
    'error takes precedence over running status',
  )
  const beforeClear = opened.length
  await evaluate("document.querySelector('.worktree-error').click()")
  await until("!document.querySelector('.worktree-error')")
  assert.equal(opened.length, beforeClear)
  assert.equal(
    await evaluate(
      "!!document.querySelector('.editor-status:not(.has-error) .editor-dot.running')",
    ),
    true,
  )
  assert.equal(
    snapshot.worktrees.find((row) => row.branch === 'main').error,
    undefined,
  )
  await search('pending-create')
  assert.equal(
    await evaluate(
      "document.querySelector('.worktree-open').getAttribute('aria-busy')",
    ),
    'true',
  )
  stage =
    'completed creation becomes the keyboard selection without changing search'
  assert.equal((await state()).index, -1)
  const pendingOpenCount = opened.length
  await key('ENTER')
  assert.equal(opened.length, pendingOpenCount)
  await update(
    snapshot.worktrees.map((row) =>
      row.path === 'C:/demo/pending-create'
        ? { ...row, operation: undefined, missing: undefined }
        : row,
    ),
  )
  assert.equal((await state()).index, 0)
  assert.equal((await state()).searchFocused, true)
  await key('ENTER')
  assert.equal(opened.length, pendingOpenCount + 1)
  assert.equal(opened.at(-1), 'C:/demo/pending-create')

  stage = 'keyboard navigation dismisses open and delayed tooltips'
  await update(
    ['tooltip-a', 'tooltip-b'].map((name) => ({
      ...worktree(`C:/demo/${name}`, name),
      editor: 'starting',
      editorDetail: 'Starting test editor',
    })),
  )
  await search('tooltip')
  const firstRow = '.worktree-list li:first-child .worktree-open'
  const tooltipOpen = "!!document.querySelector('[role=tooltip]')"
  const tooltipClosed = "!document.querySelector('[role=tooltip]')"
  await moveMouse(firstRow)
  await until(tooltipOpen)
  await key('DOWN')
  await until(tooltipClosed)
  assert.equal((await state()).searchFocused, true)
  assert.equal((await state()).index, 1)
  await moveMouse('.toolbar button')
  await moveMouse(firstRow)
  await key('DOWN')
  await delay(650)
  assert.equal(
    await evaluate(tooltipClosed),
    true,
    'delayed hover stays dismissed',
  )

  stage = 'actionable spinning rows dismiss tooltips on click'
  await moveMouse('.toolbar button')
  await moveMouse(firstRow)
  await until(tooltipOpen)
  holdOpen = true
  const beforeTooltipOpen = opened.length
  await clickMouse(firstRow)
  await until(tooltipClosed)
  assert.equal(opened.length, beforeTooltipOpen + 1)

  stage = 'ignored busy clicks preserve tooltips; Escape and leaving dismiss'
  await moveMouse('.toolbar button')
  await moveMouse(firstRow)
  await until(tooltipOpen)
  await clickMouse(firstRow)
  assert.equal(await evaluate(tooltipOpen), true)
  assert.equal(opened.length, beforeTooltipOpen + 1)
  await key('ESCAPE')
  await until(tooltipClosed)
  await moveMouse('.toolbar button')
  await moveMouse(firstRow)
  await until(tooltipOpen)
  await moveMouse('.toolbar button')
  await until(tooltipClosed)
  finishOpen()
  holdOpen = false

  stage = 'native disabled rows also preserve tooltips on ignored clicks'
  await update(
    snapshot.worktrees.map((row) => ({ ...row, operation: 'creating' })),
  )
  await moveMouse(firstRow)
  await until(tooltipOpen)
  await clickMouse(firstRow)
  assert.equal(await evaluate(tooltipOpen), true)
  assert.equal(opened.length, beforeTooltipOpen + 1)
  await moveMouse('.toolbar button')
  await until(tooltipClosed)

  stage = 'open worktrees precede unopened worktrees in pick order'
  await update([
    worktree('C:/demo/order-closed', 'order'),
    { ...worktree('C:/demo/order-a', 'order'), editor: 'running' },
    { ...worktree('C:/demo/order-b', 'order'), editor: 'starting' },
    worktree('C:/demo/order-unpicked', 'order'),
  ])
  await search('order')
  const rowPaths = () =>
    evaluate(
      "[...document.querySelectorAll('.worktree-open')].map(button => JSON.parse(button.dataset.pickerKey)[1])",
    )
  assert.deepEqual(await rowPaths(), [
    'C:/demo/order-a',
    'C:/demo/order-b',
    'C:/demo/order-closed',
    'C:/demo/order-unpicked',
  ])
  await key('DOWN')
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:/demo/order-b')
  assert.equal((await rowPaths())[0], 'C:/demo/order-b')
  assert.equal(JSON.parse((await state()).selected)[1], 'C:/demo/order-b')
  await key('DOWN')
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:/demo/order-a')
  assert.equal((await rowPaths())[0], 'C:/demo/order-a')

  stage = 'status changes reset selection and closed worktrees retain order'
  await key('DOWN')
  await update(
    snapshot.worktrees.map((row) =>
      row.path === 'C:/demo/order-a' ? { ...row, editor: 'stopped' } : row,
    ),
  )
  assert.equal((await state()).index, 0)
  assert.equal((await state()).scroll, 0)
  await assertSelectionInView()
  assert.deepEqual(await rowPaths(), [
    'C:/demo/order-b',
    'C:/demo/order-closed',
    'C:/demo/order-a',
    'C:/demo/order-unpicked',
  ])
  await update(snapshot.worktrees.map((row) => ({ ...row, editor: 'running' })))
  window.webContents.send('test:hidden')
  await until("document.querySelector('input[type=search]').value===''")
  assert.deepEqual(await rowPaths(), [
    'C:/demo/order-a',
    'C:/demo/order-b',
    'C:/demo/order-closed',
    'C:/demo/order-unpicked',
  ])
  assert.equal((await state()).index, 0)

  stage = 'status reordering keeps the Enter target visible in a long list'
  await update(
    Array.from({ length: 40 }, (_, index) => ({
      ...worktree(`C:/demo/long-${index}`, 'long'),
      editor: 'running',
    })),
  )
  await search('long')
  await update(
    snapshot.worktrees.map((row, index) =>
      index === 0 ? { ...row, editor: 'stopped' } : row,
    ),
  )
  assert.equal((await state()).index, 0)
  assert.equal((await state()).scroll, 0)
  await assertSelectionInView()
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:/demo/long-1')

  stage = 'reordering resets a scrolled and focused result to the top'
  for (let i = 0; i < 20; i++) await key('DOWN')
  assert.ok((await state()).scroll > 0)
  const selectedLongPath = JSON.parse((await state()).selected)[1]
  await evaluate(
    "document.querySelector('.worktree-list li[data-highlighted] .worktree-open').focus({preventScroll:true})",
  )
  await update(
    snapshot.worktrees.map((row) =>
      row.path === selectedLongPath ? { ...row, editor: 'stopped' } : row,
    ),
  )
  assert.equal((await state()).index, 0)
  assert.equal((await state()).scroll, 0)
  assert.equal((await state()).searchFocused, true)
  await assertSelectionInView()
  await key('ENTER')
  assert.equal(opened.at(-1), 'C:/demo/long-1')
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
