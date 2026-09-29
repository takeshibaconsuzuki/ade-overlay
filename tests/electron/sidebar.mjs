import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const input = JSON.parse(
  readFileSync(process.env.ADE_SIDEBAR_TEST_INPUT, 'utf8'),
)
app.setPath('userData', join(input.root, 'browser'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let stage = 'loading sidebar'
const deadline = setTimeout(() => {
  writeFileSync(input.result, JSON.stringify({ ok: false, stage }))
  app.exit(1)
}, 25_000)
const chat = (id, path, activity, title, message) => ({
  id,
  provider: 'codex',
  terminalId: id,
  project: '/project',
  path,
  activity,
  title,
  message,
})
const state = {
  type: 'state',
  selectedProvider: 'codex',
  activeChatId: 'two',
  chats: [
    chat(
      'one',
      'E:\\Devel\\ade-overlay',
      'working',
      'Custom chat sidebar',
      'Add a provider selector and live conversation previews. Wrap long messages into three reserved lines and truncate anything that does not fit in that space.',
    ),
    chat(
      'two',
      '/worktrees/fix-navigation',
      'idle',
      'Fix terminal navigation',
      'Navigation now restores the correct terminal.',
    ),
    chat('three', '/worktrees/new-session', 'idle'),
  ],
}
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width: 340,
      height: 540,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    const html = join(input.root, 'index.html')
    writeFileSync(
      html,
      `<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="${pathToFileURL(join(input.root, 'assets/sidebar.css')).href}"></head><body><div id="root"></div><script>window.actions=[];window.acquireVsCodeApi=()=>({postMessage:message=>window.actions.push(message)});</script><script src="${pathToFileURL(join(input.root, 'assets/sidebar.js')).href}"></script></body></html>`,
    )
    await window.loadFile(html)
    const run = (code) => window.webContents.executeJavaScript(code, true)
    async function until(code) {
      for (let i = 0; i < 100; i++) {
        if (await run(code)) return
        await delay(30)
      }
      throw new Error(`Timed out: ${stage}`)
    }
    const send = async () => {
      await run(`window.postMessage(${JSON.stringify(state)}, '*')`)
      await delay(60)
    }
    await until("window.actions.some(a=>a.type==='ready')")
    await send()
    await until("document.querySelectorAll('.chat-row').length === 3")
    stage = 'shared worktree colors'
    const nameColor = () =>
      run("getComputedStyle(document.querySelector('.chat-worktree')).color")
    const grey = await nameColor()
    state.chats[0].color = 'blue'
    await send()
    const blue = await nameColor()
    assert.notEqual(blue, grey, 'assigned color reaches the chat worktree name')
    assert.notEqual(
      blue,
      await run(
        "getComputedStyle(document.querySelector('.chat-title')).color",
      ),
    )
    state.chats[0].color = undefined
    await send()
    assert.equal(await nameColor(), grey)

    assert.deepEqual(
      await run(
        "Array.from(document.querySelectorAll('.chat-worktree'),x=>x.textContent)",
      ),
      ['ade-overlay', 'fix-navigation', 'new-session'],
    )
    assert.equal(
      await run(
        'document.querySelectorAll(\'[aria-label="Loading chat title"]\').length',
      ),
      1,
    )
    assert.equal(
      await run(
        'document.querySelectorAll(\'[aria-label="Loading chat message"]\').length',
      ),
      1,
    )
    assert.equal(
      await run("document.querySelectorAll('.chat-idle-dot').length"),
      2,
    )
    assert.equal(
      await run(
        "document.querySelector('.chat-row[aria-current=true] .chat-worktree').textContent",
      ),
      'fix-navigation',
    )
    assert.deepEqual(
      await run(
        "Array.from(document.querySelectorAll('.chat-message'),e=>e.getBoundingClientRect().height)",
      ),
      [54, 54, 54],
    )
    assert.equal(
      await run(
        "document.querySelectorAll('.chat-message-skeleton .ui-skeleton-line').length",
      ),
      3,
    )
    await delay(150)
    assert.equal(
      await run(
        "getComputedStyle(document.querySelector('.chat-row[aria-current=true]')).backgroundColor",
      ),
      'rgba(0, 0, 0, 0)',
    )
    assert.equal(
      await run(`Array.from(document.querySelectorAll('.chat-row')).every(row => {
      const status = row.querySelector('.chat-status').getBoundingClientRect();
      const worktree = row.querySelector('.chat-worktree').getBoundingClientRect();
      const title = row.querySelector('.chat-title').getBoundingClientRect();
      return Math.abs(status.y + status.height / 2 - (worktree.y + title.bottom) / 2) < 1;
    })`),
      true,
      'status centers on worktree and title, excluding the message',
    )
    // A hidden window does not receive native pointer hover. Exercise Chromium's
    // real CSS cascade through its pseudo-state override instead.
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('DOM.enable')
    await window.webContents.debugger.sendCommand('CSS.enable')
    const { root } =
      await window.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await window.webContents.debugger.sendCommand(
      'DOM.querySelector',
      { nodeId: root.nodeId, selector: '.chat-row[aria-current=true]' },
    )
    await window.webContents.debugger.sendCommand('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: ['hover'],
    })
    assert.notEqual(
      await run(
        "getComputedStyle(document.querySelector('.chat-row[aria-current=true]')).backgroundColor",
      ),
      'rgba(0, 0, 0, 0)',
      'selected row still shows hover feedback',
    )
    await window.webContents.debugger.sendCommand('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: [],
    })
    window.webContents.debugger.detach()
    writeFileSync(
      input.screenshot,
      (await window.webContents.capturePage()).toPNG(),
    )
    stage = 'provider dropdown'
    await run(
      "document.querySelector('[aria-label=\"Select chat provider\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))",
    )
    await until("document.querySelectorAll('[role=menuitemradio]').length===2")
    await run(
      "Array.from(document.querySelectorAll('[role=menuitemradio]')).find(x=>x.textContent.includes('Claude')).click()",
    )
    await until(
      "window.actions.some(a=>a.type==='select-provider' && a.provider==='claude')",
    )
    state.selectedProvider = 'claude'
    await send()
    await run(
      "document.querySelector('[aria-label=\"Select chat provider\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))",
    )
    await until("document.querySelectorAll('[role=menuitemradio]').length===2")
    await run(
      "Array.from(document.querySelectorAll('[role=menuitemradio]')).find(x=>x.textContent.includes('Claude')).click()",
    )
    await until(
      "window.actions.filter(a=>a.type==='select-provider' && a.provider==='claude').length===2",
    )
    stage = 'launch and activation actions'
    await run(
      "document.querySelector('.chat-provider-button > button').click(); document.querySelector('.chat-provider-button > button').click(); document.querySelector('.chat-launchers > button').click(); document.querySelector('.chat-row').click()",
    )
    const actions = await run('window.actions')
    assert.equal(
      actions.filter((a) => a.type === 'launch' && a.kind === 'claude').length,
      2,
    )
    assert.ok(actions.some((a) => a.type === 'launch' && a.kind === 'terminal'))
    assert.ok(actions.some((a) => a.type === 'activate' && a.chatId === 'one'))
    stage = 'content updates and safe rendering'
    state.chats[2].title = 'Loaded title'
    state.chats[2].message = '<img src=x onerror="window.injected=true">'
    await send()
    assert.equal(
      await run("document.querySelectorAll('.ui-skeleton-line').length"),
      0,
    )
    assert.equal(
      await run("document.querySelectorAll('.chat-message img').length"),
      0,
    )
    assert.equal(
      await run("document.querySelectorAll('.chat-message')[2].textContent"),
      state.chats[2].message,
    )
    stage = 'narrow viewport'
    window.setSize(220, 540)
    await delay(50)
    assert.equal(
      await run('document.documentElement.scrollWidth <= window.innerWidth'),
      true,
    )
    writeFileSync(input.result, JSON.stringify({ ok: true }))
    clearTimeout(deadline)
    app.exit(0)
  })
  .catch((error) => {
    writeFileSync(
      input.result,
      JSON.stringify({ ok: false, stage, error: error.stack }),
    )
    app.exit(1)
  })
