import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import react from '@vitejs/plugin-react'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'

type RecordedRequest = {
  method: string
  path: string
  body: unknown
}

declare global {
  interface Window {
    __desktopCalls: string[]
    __apiCalls: RecordedRequest[]
    desktop: {
      chooseFiles: (options: {
        title: string
        allowed: ('d' | 'f')[]
      }) => Promise<string[]>
      openWorktreesWindow: () => Promise<void>
      closeWindow: () => Promise<void>
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
      providerId: 'claude',
      sessionId: 'live-session',
      status: 'running',
    },
  ],
}

let vite: ViteDevServer
let browser: Browser
let rendererUrl: string

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

test('worktree list filters, opens rows, and confirms dirty deletes', async () => {
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
  const row = page.getByRole('option', { name: /project-feature/ })
  await row.getByRole('button', { name: 'Worktree actions' }).click()
  await page
    .getByRole('menuitem', { name: 'Delete worktree', exact: true })
    .click()
  await page.getByRole('button', { name: 'Force delete' }).click()

  await page.waitForFunction(() => {
    const deletes = window.__apiCalls.filter(
      (call) =>
        call.method === 'DELETE' && call.path === '/worktrees/bbbbbbbbbbbb',
    )
    return deletes.some(
      (call) => (call.body as { force?: boolean }).force === true,
    )
  })

  const deletes = (await page.evaluate(() => window.__apiCalls)).filter(
    (call) => call.method === 'DELETE',
  )
  assert.equal(deletes.length, 2)
  assert.equal((deletes[0].body as { force?: boolean }).force, false)
  assert.equal((deletes[1].body as { force?: boolean }).force, true)

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
  await page.getByRole('button', { name: 'New chat' }).click()
  await page.getByRole('tab', { name: 'Historical' }).click()
  await page.getByRole('button', { name: /Past fix/ }).click()

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
    (terminalCreates[1].body as { resumeSessionId?: string }).resumeSessionId,
    'history-1',
  )

  await page.close()
})

async function newMockedPage(): Promise<Page> {
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.__desktopCalls = []
    window.__apiCalls = []
    window.desktop = {
      chooseFiles: async () => {
        window.__desktopCalls.push('chooseFiles')
        return ['/repos/project']
      },
      openWorktreesWindow: async () => {
        window.__desktopCalls.push('openWorktreesWindow')
      },
      closeWindow: async () => {
        window.__desktopCalls.push('closeWindow')
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
    await sse(route, 'snapshot', worktreeSnapshot)
  } else if (path === '/worktrees' && request.method() === 'POST') {
    await json(route, {
      worktreeId: 'dddddddddddd',
      worktree: {
        ...worktreeSnapshot.worktrees[1],
        worktreeId: 'dddddddddddd',
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
    const force = (body as { force?: boolean } | undefined)?.force === true
    await json(
      route,
      force
        ? { deleted: true, branchDeleted: false }
        : {
            error: 'WORKTREE_DIRTY',
            message: '/repos/project-feature has uncommitted changes.',
          },
      force ? 200 : 409,
    )
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
    const worktreeId =
      path === '/showEditor'
        ? (body as { worktreeId?: string }).worktreeId
        : path.split('/')[2]
    await json(route, {
      worktreeId,
      url: 'http://bbbbbbbbbbbb.localhost:3000/__ade-overlay/editor-bootstrap',
      alreadyStarted: true,
    })
  } else if (path === '/chats/live' && request.method() === 'GET') {
    await sse(route, 'snapshot', chatSnapshot)
  } else if (path === '/showChat') {
    await json(route, { ok: true })
  } else if (path === '/chats/commands') {
    await sse(route, 'snapshot', {})
  } else if (path === '/chats/history') {
    await json(route, {
      sessions: [
        {
          sessionId: 'history-1',
          providerId: 'claude',
          worktreeId: 'bbbbbbbbbbbb',
          title: 'Past fix',
          updatedAt: Date.parse('2026-06-18T10:00:00Z'),
        },
      ],
    })
  } else if (path === '/terminals' && request.method() === 'GET') {
    await sse(route, 'snapshot', terminalSnapshot)
  } else if (path === '/terminals' && request.method() === 'POST') {
    const requestBody = body as {
      worktreeId: string
      providerId?: string
      resumeSessionId?: string
      title?: string
    }
    await json(route, {
      terminalId: requestBody.resumeSessionId ? 'term-history' : 'term-new',
      worktreeId: requestBody.worktreeId,
      providerId: requestBody.providerId ?? 'claude',
      sessionId: requestBody.resumeSessionId ?? 'new-session',
      title: requestBody.title,
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
