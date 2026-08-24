import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import react from '@vitejs/plugin-react'
import {
  chromium,
  type Browser,
  type Page,
  type Route,
  type WebSocketRoute,
} from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { clipboardReadPasteParts } from '../../src/renderer/src/chat/clipboardPaste'
import { droppedFilePathInput } from '../../src/renderer/src/chat/imageDrop'

type RecordedRequest = {
  method: string
  path: string
  body: unknown
}

declare global {
  interface Window {
    __desktopCalls: string[]
    __launcherEvents: string[]
    __apiCalls: RecordedRequest[]
    desktop: {
      chooseFiles: (options: {
        title: string
        allowed: ('d' | 'f')[]
      }) => Promise<string[]>
      getPathForFile: (file: File) => string
      openWorktreesWindow: () => Promise<void>
      setLauncherDormant: () => Promise<void>
      closeWindow: () => Promise<void>
      openExternalUrl: (url: string) => Promise<void>
    }
  }
}

const worktreeSnapshot = {
  repositories: [
    {
      mainWorktreePath: '/repos/project',
      bootstrapCommand: 'npm install',
    },
  ],
  worktrees: [
    {
      worktreeId: 'aaaaaaaaaaaa',
      name: 'project',
      path: '/repos/project',
      mainWorktreePath: '/repos/project',
      isMain: true,
      branch: 'refs/heads/main',
      branchName: 'main',
      isBare: false,
      isDetached: false,
      isPrunable: false,
      creationState: 'ready',
      hasCreationLogs: false,
      isOpenable: true,
    },
    {
      worktreeId: 'bbbbbbbbbbbb',
      name: 'project-feature',
      path: '/repos/project-feature',
      mainWorktreePath: '/repos/project',
      isMain: false,
      branch: 'refs/heads/feature/one',
      branchName: 'feature/one',
      isBare: false,
      isDetached: false,
      isPrunable: false,
      creationState: 'ready',
      hasCreationLogs: false,
      isOpenable: true,
    },
    {
      worktreeId: 'cccccccccccc',
      name: 'project-failed',
      path: '/repos/project-failed',
      mainWorktreePath: '/repos/project',
      isMain: false,
      branchName: 'feature/fail',
      isBare: false,
      isDetached: false,
      isPrunable: false,
      creationState: 'failed',
      creationError: 'Bootstrap failed',
      hasCreationLogs: true,
      isOpenable: true,
    },
    {
      worktreeId: 'dddddddddddd',
      name: 'project-windows',
      path: 'C:\\repos\\project-windows',
      mainWorktreePath: '/repos/project',
      isMain: false,
      branch: 'refs/heads/feature/windows',
      branchName: 'feature/windows',
      isBare: false,
      isDetached: false,
      isPrunable: false,
      creationState: 'ready',
      hasCreationLogs: false,
      isOpenable: true,
    },
  ],
  selectedWorktreeId: 'bbbbbbbbbbbb',
}

const chatSnapshot = {
  chats: [
    {
      chatId: 'live-session',
      providerId: 'claude',
      status: 'busy',
      title: 'Live investigation',
      description: 'Inspect renderer behavior',
      worktreeId: 'bbbbbbbbbbbb',
      terminalId: 'term-live',
      updatedAt: Date.parse('2026-06-18T12:00:00Z'),
    },
    {
      chatId: 'ended-session',
      providerId: 'codex',
      status: 'dormant',
      title: 'Finished chat',
      updatedAt: Date.parse('2026-06-18T11:00:00Z'),
    },
  ],
}

const terminalSnapshot = {
  terminals: [
    {
      terminalId: 'term-live',
      worktreeId: 'bbbbbbbbbbbb',
      title: 'claude · live-ses',
      status: 'running',
    },
  ],
}

let vite: ViteDevServer
let browser: Browser
let rendererUrl: string
const pageWorktreeSnapshots = new WeakMap<Page, unknown>()

before(async () => {
  vite = await createServer({
    configFile: false,
    root: resolve('src/renderer'),
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)
  rendererUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await vite?.close()
})

test('launcher renders current worktree and opens server targets', async () => {
  const page = await newMockedPage()

  await page.goto(`${rendererUrl}/#launcher`)
  await page.getByText('project-feature').first().waitFor()
  await page.getByRole('button', { name: /Live investigation/ }).click()
  await page.keyboard.press('w')
  await page.keyboard.press('c')

  await page.waitForFunction(
    () =>
      window.__apiCalls.some((call) => call.path === '/showEditor') &&
      window.__apiCalls.some((call) => call.path === '/showChat'),
  )

  const apiCalls = await page.evaluate(() => window.__apiCalls)
  assert.equal(
    apiCalls.some((call) => call.path === '/worktrees/bbbbbbbbbbbb/open'),
    false,
  )
  assert.ok(
    apiCalls.some(
      (call) =>
        call.path === '/showChat' &&
        (call.body as { worktreeId?: string; chatId?: string }).worktreeId ===
          'bbbbbbbbbbbb' &&
        (call.body as { chatId?: string }).chatId === 'live-session',
    ),
  )

  await page.close()
})

test('launcher stays active through the editor response', async () => {
  const page = await newMockedPage()

  await page.goto(`${rendererUrl}/#launcher`)
  await page.getByText('project-feature').first().waitFor()
  await page.keyboard.press('w')
  await page.waitForFunction(() =>
    window.__launcherEvents.includes('showEditorResponse'),
  )

  assert.deepEqual(await page.evaluate(() => window.__launcherEvents), [
    'showEditorResponse',
  ])
  await page.close()
})

test('worktree list filters, opens rows, and queues deletes', async () => {
  const page = await newMockedPage()

  await page.goto(`${rendererUrl}/#worktrees`)
  const search = page.getByPlaceholder(/Search worktrees/)
  await search.fill('feature one')
  await search.press('Enter')

  await page.waitForFunction(() =>
    window.__apiCalls.some(
      (call) => call.path === '/worktrees/bbbbbbbbbbbb/open',
    ),
  )

  await search.fill('')
  await page
    .getByRole('option', { name: /project-windows feature\/windows/ })
    .waitFor()
  const row = page.getByRole('option', { name: /project-feature/ })
  await row.getByRole('button', { name: 'Worktree actions' }).click()
  await page.getByRole('menuitem', { name: 'Stop VS Code server' }).click()

  await page.waitForFunction(() =>
    window.__apiCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.path === '/worktrees/bbbbbbbbbbbb/vscode-server/stop',
    ),
  )

  await row.getByRole('button', { name: 'Worktree actions' }).click()
  await page
    .getByRole('menuitem', { name: 'Delete worktree', exact: true })
    .click()
  await page.waitForFunction(() => {
    const deletes = window.__apiCalls.filter(
      (call) =>
        call.method === 'DELETE' && call.path === '/worktrees/bbbbbbbbbbbb',
    )
    return deletes.length === 1
  })

  const deletes = (await page.evaluate(() => window.__apiCalls)).filter(
    (call) => call.method === 'DELETE',
  )
  assert.equal(deletes.length, 1)
  assert.equal((deletes[0].body as { force?: boolean }).force, false)
  assert.ok(
    (await page.evaluate(() => window.__apiCalls)).some(
      (call) =>
        call.method === 'POST' &&
        call.path === '/worktrees/bbbbbbbbbbbb/vscode-server/stop',
    ),
  )

  await page.close()
})

test('reopens persisted dirty deletion failures and queues a force retry', async () => {
  const failedSnapshot = {
    ...worktreeSnapshot,
    worktrees: worktreeSnapshot.worktrees.map((worktree) =>
      worktree.worktreeId === 'bbbbbbbbbbbb'
        ? {
            ...worktree,
            deletionState: 'failed',
            deletionError: '/repos/project-feature has uncommitted changes.',
            deletionErrorCode: 'WORKTREE_DIRTY',
            deletionDeleteBranch: true,
          }
        : worktree,
    ),
  }
  const page = await newMockedPage({
    worktreeSnapshotData: failedSnapshot,
  })

  await page.goto(`${rendererUrl}/#worktrees`)
  await page.getByRole('button', { name: 'Force delete' }).click()

  await page.waitForFunction(() =>
    window.__apiCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.path === '/worktrees/bbbbbbbbbbbb' &&
        (call.body as { force?: boolean; deleteBranch?: boolean }).force ===
          true &&
        (call.body as { deleteBranch?: boolean }).deleteBranch === true,
    ),
  )
  await page.close()
})

test('reopens and acknowledges a branch deletion failure tombstone', async () => {
  const failedSnapshot = {
    ...worktreeSnapshot,
    selectedWorktreeId: undefined,
    worktrees: worktreeSnapshot.worktrees.map((worktree) =>
      worktree.worktreeId === 'bbbbbbbbbbbb'
        ? {
            ...worktree,
            deletionState: 'branch-failed',
            deletionError: 'simulated branch deletion failure',
            deletionDeleteBranch: true,
            isOpenable: false,
          }
        : worktree,
    ),
  }
  const page = await newMockedPage({
    worktreeSnapshotData: failedSnapshot,
  })

  await page.goto(`${rendererUrl}/#worktrees`)
  const tombstone = page.getByRole('option', { name: /project-feature/ })
  await tombstone.getByText('branch delete failed').waitFor()
  await tombstone
    .getByText('Worktree deleted; simulated branch deletion failure')
    .waitFor()
  assert.equal(
    await tombstone.getByRole('button', { name: 'Worktree actions' }).count(),
    0,
  )

  await tombstone
    .getByRole('button', {
      name: 'Branch deletion failed — click to dismiss',
    })
    .click()
  await page.waitForFunction(() =>
    window.__apiCalls.some(
      (call) =>
        call.method === 'POST' &&
        call.path === '/worktrees/bbbbbbbbbbbb/dismiss-deletion',
    ),
  )
  await page.close()
})

test('create worktree form previews path and submits generated values', async () => {
  const page = await newMockedPage()

  await page.goto(`${rendererUrl}/#worktrees`)
  await page.getByRole('button', { name: 'Create worktree' }).click()
  await page.getByPlaceholder('main').fill('main')
  await page.getByPlaceholder('feature/my-change').fill('feature/my-change')

  const pathInput = page.getByPlaceholder('~/worktrees/my-change')
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="~/worktrees/my-change"]',
    )
    return input?.value === '~/worktrees/feature-my-change'
  })
  await pathInput.fill('/tmp/project-feature-my-change')
  await page.getByRole('button', { name: /^Create$/ }).click()

  await page.waitForFunction(() =>
    window.__apiCalls.some((call) => call.path === '/worktrees'),
  )

  const createCall = (await page.evaluate(() => window.__apiCalls)).find(
    (call) => call.method === 'POST' && call.path === '/worktrees',
  )
  assert.deepEqual(createCall?.body, {
    mainWorktreePath: '/repos/project',
    baseBranch: 'main',
    newBranch: 'feature/my-change',
    worktreePath: '/tmp/project-feature-my-change',
    bootstrap: false,
  })

  await page.close()
})

test('chat app shows live terminals and resumes historical sessions', async () => {
  const page = await newMockedPage()

  await page.goto(`${rendererUrl}/#chat`)
  await page.getByRole('button', { name: /claude.*live-ses/ }).waitFor()
  await page.getByRole('button', { name: 'Choose chat provider' }).click()
  await page.getByRole('menuitem', { name: 'New Codex chat' }).click()
  await page.getByRole('tab', { name: 'Historical' }).click()
  await page.getByRole('button', { name: /Codex plan/ }).click()

  await page.waitForFunction(() => {
    const creates = window.__apiCalls.filter(
      (call) => call.method === 'POST' && call.path === '/terminals',
    )
    return creates.length === 2
  })

  const terminalCreates = (await page.evaluate(() => window.__apiCalls)).filter(
    (call) => call.method === 'POST' && call.path === '/terminals',
  )
  assert.equal(
    (terminalCreates[0].body as { worktreeId?: string }).worktreeId,
    'bbbbbbbbbbbb',
  )
  assert.equal(
    (terminalCreates[0].body as { providerId?: string }).providerId,
    'codex',
  )
  assert.equal(
    (terminalCreates[1].body as { resumeChatId?: string }).resumeChatId,
    'codex-history',
  )
  assert.equal(
    (terminalCreates[1].body as { providerId?: string }).providerId,
    'codex',
  )

  await page.close()
})

test('chat app can launch a new Cursor chat', async () => {
  const page = await newMockedPage()

  await page.goto(`${rendererUrl}/#chat`)
  await page.getByRole('button', { name: 'Choose chat provider' }).click()
  await page.getByRole('menuitem', { name: 'New Cursor chat' }).click()

  await page.waitForFunction(() =>
    window.__apiCalls.some(
      (call) => call.method === 'POST' && call.path === '/terminals',
    ),
  )
  const create = (await page.evaluate(() => window.__apiCalls)).find(
    (call) => call.method === 'POST' && call.path === '/terminals',
  )
  assert.equal((create?.body as { providerId?: string }).providerId, 'cursor')

  await page.close()
})

test('chat terminal shows link hover decorations only while its platform modifier is pressed', async () => {
  // This test inspects the DOM renderer's ANSI decoration spans directly.
  // Production prefers WebGL, but must preserve this behavior in its fallback.
  const page = await newMockedPage({ disableWebgl: true })
  let terminalWebSocket: WebSocketRoute | undefined
  await page.routeWebSocket(/\/terminals\/term-live\/socket/, (webSocket) => {
    terminalWebSocket = webSocket
    webSocket.send(
      JSON.stringify({
        type: 'output',
        data: '\u001b[4:4m\u001b[58:2::255:0:0mhttps://example.com\u001b[0m',
      }),
    )
  })

  await page.goto(`${rendererUrl}/#chat`)
  const terminal = page.locator('[data-terminal-id="term-live"]')
  await terminal.waitFor()
  const dottedLink = terminal.locator('.xterm-rows .xterm-underline-4')
  await dottedLink.waitFor()
  const linkCursor = terminal.locator('.xterm-screen')

  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationStyle,
    ),
    'dotted',
  )
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationLine,
    ),
    'underline',
  )
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationColor,
    ),
    'rgb(255, 0, 0)',
  )

  const dottedLinkBox = await dottedLink.boundingBox()
  assert.ok(dottedLinkBox)
  await page.mouse.move(
    dottedLinkBox.x + dottedLinkBox.width / 2,
    dottedLinkBox.y + dottedLinkBox.height / 2,
  )

  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationStyle,
    ),
    'dotted',
  )
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationLine,
    ),
    'underline',
  )
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationColor,
    ),
    'rgb(255, 0, 0)',
  )
  assert.equal(
    await linkCursor.evaluate((element) => getComputedStyle(element).cursor),
    'text',
  )

  assert.ok(terminalWebSocket)
  terminalWebSocket.send(
    JSON.stringify({
      type: 'output',
      data: '\r\u001b[4:4m\u001b[58:2::255:0:0mhttps://openai.com/\u001b[0m',
    }),
  )
  await page.waitForFunction(() =>
    document
      .querySelector(
        '[data-terminal-id="term-live"] .xterm-rows .xterm-underline-4',
      )
      ?.textContent?.includes('https://openai.com/'),
  )
  await page.evaluate(
    () => new Promise<void>((resolve) => queueMicrotask(resolve)),
  )

  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationStyle,
    ),
    'dotted',
  )
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationColor,
    ),
    'rgb(255, 0, 0)',
  )
  assert.equal(
    await linkCursor.evaluate((element) => getComputedStyle(element).cursor),
    'text',
  )

  await page.mouse.click(
    dottedLinkBox.x + dottedLinkBox.width / 2,
    dottedLinkBox.y + dottedLinkBox.height / 2,
  )
  await page.waitForTimeout(50)
  await page.waitForFunction(() => {
    const link = document.querySelector(
      '[data-terminal-id="term-live"] .xterm-rows .xterm-underline-4',
    )
    const screen = document.querySelector(
      '[data-terminal-id="term-live"] .xterm-screen',
    )
    if (!link || !screen) {
      return false
    }
    const decoration = getComputedStyle(link)
    return (
      decoration.textDecorationStyle === 'dotted' &&
      decoration.textDecorationColor === 'rgb(255, 0, 0)' &&
      getComputedStyle(screen).cursor === 'text'
    )
  })

  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationStyle,
    ),
    'dotted',
  )
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationColor,
    ),
    'rgb(255, 0, 0)',
  )
  assert.equal(
    await linkCursor.evaluate((element) => getComputedStyle(element).cursor),
    'text',
  )
  assert.equal(
    (await page.evaluate(() => window.__desktopCalls)).some((call) =>
      call.startsWith('openExternalUrl:'),
    ),
    false,
  )

  await page.evaluate(() => {
    const isMac = navigator.platform.startsWith('Mac')
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        ctrlKey: !isMac,
        metaKey: isMac,
      }),
    )
  })
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationStyle,
    ),
    'solid',
  )
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationLine,
    ),
    'underline',
  )
  assert.equal(
    await linkCursor.evaluate((element) => getComputedStyle(element).cursor),
    'pointer',
  )

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup'))
  })
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationStyle,
    ),
    'dotted',
  )
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationLine,
    ),
    'underline',
  )
  assert.equal(
    await dottedLink.evaluate(
      (element) => getComputedStyle(element).textDecorationColor,
    ),
    'rgb(255, 0, 0)',
  )
  assert.equal(
    await linkCursor.evaluate((element) => getComputedStyle(element).cursor),
    'text',
  )

  await page.close()
})

test('terminal routes ordered rich text and images through its WebSocket', async () => {
  const page = await newMockedPage({ platform: 'MacIntel' })
  await page.route('https://example.com/image.png', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'image/png',
      },
      body: 'pixels',
    }),
  )
  const inputs: string[] = []
  let markControlVReceived: (() => void) | undefined
  const controlVReceived = new Promise<void>((resolve) => {
    markControlVReceived = resolve
  })
  let markPasteReceived:
    | ((message: Record<string, unknown>) => void)
    | undefined
  const pasteReceived = new Promise<Record<string, unknown>>((resolve) => {
    markPasteReceived = resolve
  })
  await page.routeWebSocket(/\/terminals\/term-live\/socket/, (webSocket) => {
    webSocket.onMessage((raw) => {
      if (typeof raw !== 'string') {
        return
      }
      const message = JSON.parse(raw) as {
        type?: string
        data?: string
      }
      if (message.type === 'paste') {
        markPasteReceived?.(message)
        return
      }
      if (message.type !== 'input' || message.data === undefined) {
        return
      }
      inputs.push(message.data)
      if (message.data === '\x16') {
        markControlVReceived?.()
      }
    })
  })

  await page.goto(`${rendererUrl}/#chat`)
  const terminal = page.locator('[data-terminal-id="term-live"]')
  await terminal.waitFor()
  const textarea = terminal.locator('.xterm-helper-textarea')
  await textarea.press('Control+v')
  await controlVReceived
  await textarea.evaluate((textarea) => {
    const clipboard = new DataTransfer()
    clipboard.setData(
      'text/html',
      '<pre>    before\n\tline</pre><img src="https://example.com/image.png" alt="diagram"><code>  after\ttext</code>',
    )
    clipboard.setData('text/plain', '    before\n\tline\ndiagram  after\ttext')
    textarea.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    )
  })
  assert.deepEqual(await pasteReceived, {
    type: 'paste',
    bracketedPasteMode: false,
    parts: [
      { type: 'text', text: '    before\n\tline\n' },
      {
        type: 'image',
        mimeType: 'image/png',
        dataBase64: 'cGl4ZWxz',
        filename: 'image.png',
        alt: 'diagram',
      },
      { type: 'text', text: '  after\ttext' },
    ],
  })
  assert.deepEqual(inputs, ['\x16'])

  await page.close()
})

test('retains a paste while the terminal WebSocket reconnects', async () => {
  const page = await newMockedPage()
  let firstSocket: WebSocketRoute | undefined
  let markFirstConnection: (() => void) | undefined
  const firstConnection = new Promise<void>((resolve) => {
    markFirstConnection = resolve
  })
  let markReconnectedPaste:
    | ((message: Record<string, unknown>) => void)
    | undefined
  const reconnectedPaste = new Promise<Record<string, unknown>>((resolve) => {
    markReconnectedPaste = resolve
  })
  let connectionCount = 0
  await page.routeWebSocket(/\/terminals\/term-live\/socket/, (webSocket) => {
    connectionCount += 1
    const connection = connectionCount
    if (connection === 1) {
      firstSocket = webSocket
      markFirstConnection?.()
    }
    webSocket.onMessage((raw) => {
      if (connection < 2 || typeof raw !== 'string') {
        return
      }
      const message = JSON.parse(raw) as Record<string, unknown>
      if (message.type === 'paste') {
        markReconnectedPaste?.(message)
      }
    })
  })

  await page.goto(`${rendererUrl}/#chat`)
  await firstConnection
  assert.ok(firstSocket)
  const textarea = page.locator(
    '[data-terminal-id="term-live"] .xterm-helper-textarea',
  )
  await firstSocket.close()

  await textarea.evaluate((textarea) => {
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'paste after reconnect')
    textarea.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    )
  })

  assert.deepEqual(await reconnectedPaste, {
    type: 'paste',
    bracketedPasteMode: false,
    parts: [{ type: 'text', text: 'paste after reconnect' }],
  })

  await page.close()
})

test('falls back to text for unsupported clipboard image formats', async () => {
  const requestedTypes: string[] = []
  const parts = await clipboardReadPasteParts({
    read: async () => [
      {
        types: ['text/plain', 'image/svg+xml'],
        getType: async (type: string) => {
          requestedTypes.push(type)
          return new Blob([type === 'text/plain' ? 'diagram' : '<svg/>'], {
            type,
          })
        },
      },
    ],
    readText: async () => '',
  } as never)

  assert.deepEqual(parts, [{ type: 'text', text: 'diagram' }])
  assert.deepEqual(requestedTypes, ['text/plain'])
})

test('uses one preferred image representation per clipboard item', async () => {
  const requestedTypes: string[] = []
  const parts = await clipboardReadPasteParts({
    read: async () => [
      {
        types: ['image/jpeg', 'image/png'],
        getType: async (type: string) => {
          requestedTypes.push(type)
          return new Blob([type], { type })
        },
      },
    ],
    readText: async () => '',
  } as never)

  assert.equal(parts.length, 1)
  assert.equal(parts[0].type, 'image')
  assert.equal(parts[0].type === 'image' && parts[0].mimeType, 'image/png')
  assert.equal(
    parts[0].type === 'image' ? await parts[0].blob.text() : '',
    'image/png',
  )
  assert.deepEqual(requestedTypes, ['image/png'])
})

test('formats dropped file paths for terminal input', () => {
  const input = droppedFilePathInput(
    [
      { name: 'plain.png', type: '' },
      { name: 'screen shot 1.png', type: 'image/png' },
      { name: 'notes.txt', type: 'text/plain' },
      { name: 'manual.pdf', type: 'application/pdf' },
      { name: "quote's.webp", type: 'image/webp' },
    ],
    (file) => `/tmp/${file.name}`,
  )

  assert.equal(
    input,
    "'/tmp/plain.png' '/tmp/screen shot 1.png' '/tmp/notes.txt' '/tmp/manual.pdf' '/tmp/quote'\\''s.webp' ",
  )
})

async function newMockedPage({
  disableWebgl = false,
  platform,
  worktreeSnapshotData,
}: {
  disableWebgl?: boolean
  platform?: string
  worktreeSnapshotData?: unknown
} = {}): Promise<Page> {
  const page = await browser.newPage()
  if (worktreeSnapshotData) {
    pageWorktreeSnapshots.set(page, worktreeSnapshotData)
  }
  if (platform) {
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value,
      })
    }, platform)
  }
  if (disableWebgl) {
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (...args) {
        if (args[0] === 'webgl2') {
          return null
        }
        return Reflect.apply(getContext, this, args)
      } as typeof getContext
    })
  }
  await page.addInitScript(() => {
    window.__desktopCalls = []
    window.__launcherEvents = []
    window.__apiCalls = []
    window.desktop = {
      chooseFiles: async () => {
        window.__desktopCalls.push('chooseFiles')
        return ['/repos/project']
      },
      getPathForFile: (file) => `/tmp/${file.name}`,
      openWorktreesWindow: async () => {
        window.__desktopCalls.push('openWorktreesWindow')
      },
      setLauncherDormant: async () => {
        window.__desktopCalls.push('setLauncherDormant')
        window.__launcherEvents.push('setLauncherDormant')
      },
      closeWindow: async () => {
        window.__desktopCalls.push('closeWindow')
      },
      openExternalUrl: async (url) => {
        window.__desktopCalls.push(`openExternalUrl:${url}`)
      },
    }
  })
  await page.route('http://127.0.0.1:3000/**', handleApiRoute)
  return page
}

async function handleApiRoute(route: Route): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const path = url.pathname

  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: corsHeaders() })
    return
  }

  const body = request.postData()
    ? (request.postDataJSON() as unknown)
    : undefined
  await route
    .request()
    .frame()
    ?.page()
    .evaluate(
      (call) => {
        window.__apiCalls.push(call)
      },
      { method: request.method(), path, body },
    )

  if (path === '/logs') {
    await json(route, { received: 1 })
  } else if (path === '/worktrees' && request.method() === 'GET') {
    await sse(
      route,
      'snapshot',
      pageWorktreeSnapshots.get(request.frame()?.page()) ?? worktreeSnapshot,
    )
  } else if (path === '/worktrees' && request.method() === 'POST') {
    await json(route, {
      worktreeId: 'dddddddddddd',
      worktree: {
        ...worktreeSnapshot.worktrees[1],
        worktreeId: 'dddddddddddd',
        name: 'project-feature-my-change',
        path: (body as { worktreePath?: string }).worktreePath,
      },
    })
  } else if (path === '/worktrees/path-preview') {
    const newBranch =
      (body as { newBranch?: string; baseBranch?: string }).newBranch ||
      (body as { baseBranch?: string }).baseBranch ||
      ''
    await json(route, {
      worktreePath: `~/worktrees/${newBranch.replaceAll('/', '-')}`,
    })
  } else if (path === '/repositories/branches') {
    await json(route, { branches: ['main', 'feature/one', 'release'] })
  } else if (path === '/worktrees/bbbbbbbbbbbb') {
    await json(route, {
      worktreeId: 'bbbbbbbbbbbb',
      worktree: {
        ...worktreeSnapshot.worktrees[1],
        deletionState: 'deleting',
        deletionDeleteBranch:
          (body as { deleteBranch?: boolean } | undefined)?.deleteBranch ===
          true,
        isOpenable: false,
      },
    })
  } else if (path === '/editorSessions') {
    await sse(route, 'snapshot', [
      {
        worktreeId: 'bbbbbbbbbbbb',
        status: 'on',
        lastSwitchAt: '2026-06-18T12:00:00.000Z',
      },
    ])
  } else if (
    path.match(/^\/worktrees\/[^/]+\/open$/) ||
    path === '/showEditor'
  ) {
    const isShowEditor = path === '/showEditor'
    const worktreeId = isShowEditor
      ? (body as { worktreeId?: string }).worktreeId
      : path.split('/')[2]
    if (isShowEditor) {
      await route
        .request()
        .frame()
        ?.page()
        .evaluate(() => window.__launcherEvents.push('showEditorResponse'))
    }
    await json(route, {
      worktreeId,
      url: 'http://bbbbbbbbbbbb.localhost:3000/__ade-overlay/editor-bootstrap',
      ...(isShowEditor
        ? { alreadyStarted: true }
        : { editorAlreadyStarted: true }),
    })
  } else if (path === '/chats/live' && request.method() === 'GET') {
    await sse(route, 'snapshot', chatSnapshot)
  } else if (path === '/showChat') {
    await json(route, { ok: true })
  } else if (path === '/chats/commands') {
    await sse(route, 'snapshot', {})
  } else if (path === '/chats/history') {
    await json(route, {
      chats: [
        {
          chatId: 'history-1',
          providerId: 'claude',
          status: 'dormant',
          worktreeId: 'bbbbbbbbbbbb',
          title: 'Past fix',
          updatedAt: Date.parse('2026-06-18T10:00:00Z'),
        },
        {
          chatId: 'codex-history',
          providerId: 'codex',
          status: 'dormant',
          worktreeId: 'bbbbbbbbbbbb',
          title: 'Codex plan',
          updatedAt: Date.parse('2026-06-18T09:00:00Z'),
        },
      ],
    })
  } else if (path === '/terminals' && request.method() === 'GET') {
    await sse(route, 'snapshot', terminalSnapshot)
  } else if (path === '/terminals' && request.method() === 'POST') {
    const requestBody = body as {
      worktreeId: string
      providerId?: string
      resumeChatId?: string
      title?: string
    }
    await json(route, {
      terminalId: requestBody.resumeChatId ? 'term-history' : 'term-new',
      worktreeId: requestBody.worktreeId,
      title:
        requestBody.title ??
        (requestBody.resumeChatId
          ? `${requestBody.providerId ?? 'claude'} · ${requestBody.resumeChatId.slice(0, 8)}`
          : `New ${requestBody.providerId ?? 'claude'} chat`),
      status: 'running',
    })
  } else {
    await json(route, { ok: true })
  }
}

async function json(
  route: Route,
  payload: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    headers: corsHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  })
}

async function sse(
  route: Route,
  event: string,
  payload: unknown,
): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: corsHeaders({ 'content-type': 'text/event-stream' }),
    body: `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  })
}

function corsHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-origin': '*',
    ...extra,
  }
}
