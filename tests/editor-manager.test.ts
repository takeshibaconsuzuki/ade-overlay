import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  EditorWindowManager,
  type EditorHost,
  type EditorPage,
} from '../src/desktop/editor/manager'
import type { EditorState } from '../src/desktop/editor/api'
import type {
  ChatTerminalLaunch,
  VscodeServerStatus,
  Worktree,
} from '../src/shared/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class Page implements EditorPage {
  launches: ChatTerminalLaunch[] = []
  focused: string[] = []
  async focusChatTerminal(id: string): Promise<boolean> {
    this.focused.push(id)
    return true
  }
  async openChatTerminal(options: ChatTerminalLaunch): Promise<void> {
    this.launches.push(options)
  }
  readonly loading = deferred<void>()
  urls: string[] = []
  disposed = false
  constructor(readonly fail: (message: string) => void) {}
  crash(): void {
    this.fail('The VS Code page closed unexpectedly. Retry to reopen it.')
  }
  load(url: string): Promise<void> {
    this.urls.push(url)
    return this.loading.promise
  }
  async prepareForDisconnect(): Promise<void> {}
  dispose(): void {
    this.disposed = true
  }
}

class Host implements EditorHost {
  pages: Page[] = []
  current: EditorPage | undefined
  state: EditorState = { title: '', canRetry: false }
  shown = 0
  closed = false
  showAndFocusWindow(): void {
    this.shown++
  }
  createPage(_key: string, onFailure: (message: string) => void): Page {
    const page = new Page(onFailure)
    this.pages.push(page)
    return page
  }
  setContent(page: EditorPage | undefined, state: EditorState): void {
    this.current = page
    this.state = state
  }
  close(): void {
    this.closed = true
  }
}

const a: Worktree = {
  path: '/repo/a',
  basename: 'a',
  branchName: 'a',
  mainWorktreePath: '/repo/a',
  deleting: false,
  vscode: { path: '/repo/a', state: 'stopped' },
}
const b: Worktree = {
  path: '/repo/b',
  basename: 'b',
  branchName: 'b',
  mainWorktreePath: '/repo/a',
  deleting: false,
  vscode: { path: '/repo/b', state: 'stopped' },
}
function withStatus(
  worktree: Worktree,
  status: Omit<VscodeServerStatus, 'path'>,
): Worktree {
  return { ...worktree, vscode: { path: worktree.path, ...status } }
}
function running(worktree: Worktree): Worktree {
  return withStatus(worktree, {
    state: 'running',
    browserPath: `/vscode/${'a'.repeat(64)}/?tkn=secret`,
  })
}

test('duplicate clicks share startup; readiness and page load gate presentation', async () => {
  const host = new Host()
  const ack = deferred<void>()
  let starts = 0
  const manager = new EditorWindowManager(
    host,
    {
      ensure: () => {
        starts++
        return ack.promise
      },
    },
    'wss://remote.example/rpc',
  )
  const first = manager.open(a)
  assert.equal(manager.open(a), first)
  await setImmediate()
  assert.equal(starts, 1)
  manager.updateWorktrees([running(a)])
  assert.equal(host.pages.length, 0)
  ack.resolve()
  await first
  assert.equal(host.pages.length, 1)
  assert.equal(host.current, undefined)
  assert.match(host.pages[0].urls[0], /^https:\/\/remote.example\/vscode\//)
  host.pages[0].loading.resolve()
  await setImmediate()
  assert.equal(host.current, host.pages[0])
  await manager.open(a)
  assert.equal(starts, 1)
  assert.equal(host.pages[0].urls.length, 1)
  await manager.close()
})

test('latest selection wins; background completion never steals focus or reloads pages', async () => {
  const host = new Host()
  const manager = new EditorWindowManager(
    host,
    { ensure: async () => {} },
    'ws://remote.example/rpc',
  )
  await manager.open(a)
  await manager.open(b)
  manager.updateWorktrees([running(a), running(b)])
  host.pages[1].loading.resolve()
  await setImmediate()
  assert.equal(host.current, host.pages[1])
  host.pages[0].loading.resolve()
  await setImmediate()
  assert.equal(host.current, host.pages[1])
  assert.equal(host.shown, 2)
  await manager.open(a)
  assert.equal(host.current, host.pages[0])
  assert.equal(host.pages.length, 2)
  manager.onServerDisconnected()
  assert.equal(host.current, host.pages[0])
  assert.equal(host.state.error, undefined)
  await manager.close()
  assert.ok(host.pages.every((page) => page.disposed))
  assert.ok(host.closed)
})

test('startup and initial navigation failures need explicit retry', async () => {
  const host = new Host()
  let starts = 0
  const manager = new EditorWindowManager(
    host,
    {
      ensure: async () => {
        starts++
      },
    },
    'ws://remote.example/rpc',
  )
  await manager.open(a)
  manager.updateWorktrees([
    { ...a, error: { id: '1', message: 'launch failed' } },
  ])
  assert.equal(host.state.error, 'launch failed')
  manager.updateWorktrees([running(a)])
  assert.equal(host.pages.length, 0)
  await manager.retry()
  host.pages[0].loading.reject(new Error('network failure with sensitive URL'))
  await setImmediate()
  assert.match(host.state.error!, /Unable to load VS Code/)
  assert.equal(starts, 2)
  await manager.retry()
  assert.equal(starts, 3)
  assert.ok(host.pages[0].disposed)
  host.pages[1].loading.resolve()
  await setImmediate()
  assert.equal(host.current, host.pages[1])
  host.pages[0].crash()
  assert.equal(host.current, host.pages[1])
  assert.equal(host.state.error, undefined)
  host.pages[1].crash()
  assert.match(host.state.error!, /closed unexpectedly/)
  await manager.close()
})

for (const loaded of [false, true]) {
  test(`page initialization failure ${loaded ? 'after' : 'before'} navigation uses the existing retry flow`, async () => {
    const host = new Host()
    let ensures = 0
    const manager = new EditorWindowManager(
      host,
      {
        ensure: async () => {
          ensures++
        },
      },
      'ws://localhost/rpc',
    )
    manager.updateWorktrees([running(a)])
    await manager.open(a)
    const failedPage = host.pages[0]
    if (loaded) {
      failedPage.loading.resolve()
      await setImmediate()
    }
    const message = 'Unable to load host extension enablement.'
    failedPage.fail(message)
    failedPage.loading.resolve()
    await setImmediate()
    manager.updateWorktrees([running(a)])
    assert.equal(host.current, undefined)
    assert.equal(host.state.error, message)
    assert.equal(host.state.canRetry, true)
    assert.equal(host.pages.length, 1, 'failure waits for an explicit retry')

    await manager.retry()
    assert.equal(ensures, 2)
    assert.equal(failedPage.disposed, true)
    const replacement = host.pages[1]
    assert.equal(replacement.urls[0], failedPage.urls[0])
    replacement.loading.resolve()
    await setImmediate()
    failedPage.fail('stale failure')
    assert.equal(host.current, replacement)
    assert.equal(host.state.error, undefined)
    await manager.close()
  })
}

for (const loaded of [false, true]) {
  for (const change of ['stopped', 'starting', 'route'] as const) {
    test(`opening a ${loaded ? 'loaded' : 'loading'} page replaces it when the server is ${change}`, async () => {
      const host = new Host()
      let starts = 0
      const manager = new EditorWindowManager(
        host,
        {
          ensure: async () => {
            starts++
            manager.updateWorktrees([running(a)])
          },
        },
        'ws://localhost/rpc',
      )
      await manager.open(a)
      const oldPage = host.pages[0]
      if (loaded) {
        oldPage.loading.resolve()
        await setImmediate()
      }
      const save = deferred<void>()
      let saves = 0
      oldPage.prepareForDisconnect = () => {
        saves++
        return save.promise
      }
      manager.onServerDisconnected()
      manager.updateWorktrees([
        change === 'route'
          ? withStatus(a, {
              ...running(a).vscode,
              browserPath: `${running(a).vscode.browserPath}-new`,
            })
          : withStatus(a, { state: change }),
      ])
      const opening = manager.open(a)
      assert.equal(manager.open(a), opening)
      assert.equal(host.current, undefined)
      assert.equal(saves, 1)
      assert.equal(oldPage.disposed, false)
      assert.equal(starts, 1)
      oldPage.loading.resolve()
      oldPage.crash()
      await setImmediate()
      assert.equal(host.current, undefined)
      assert.equal(host.state.error, undefined)
      save.resolve()
      await opening
      assert.equal(starts, 2)
      assert.equal(oldPage.disposed, true)
      assert.equal(host.pages.length, 2)
      host.pages[1].loading.resolve()
      await setImmediate()
      assert.equal(host.current, host.pages[1])
      assert.equal(host.state.error, undefined)
      await manager.close()
    })
  }
}

test('temporary disconnect and an unchanged server reuse the page without startup or saving', async () => {
  const host = new Host()
  let starts = 0
  const manager = new EditorWindowManager(
    host,
    {
      ensure: async () => {
        starts++
      },
    },
    'ws://localhost/rpc',
  )
  await manager.open(a)
  manager.updateWorktrees([running(a)])
  const page = host.pages[0]
  page.loading.resolve()
  await setImmediate()
  let saves = 0
  page.prepareForDisconnect = async () => {
    saves++
  }
  manager.onServerDisconnected()
  await manager.open(a)
  manager.updateWorktrees([running(a)])
  await manager.open(a)
  assert.equal(starts, 1)
  assert.equal(saves, 0)
  assert.equal(host.current, page)
  assert.equal(host.pages.length, 1)
  assert.equal(page.disposed, false)
  await manager.close()
})

test('replacement continues after a session save fails and uses the new browser route', async () => {
  const host = new Host()
  const manager = new EditorWindowManager(
    host,
    { ensure: async () => {} },
    'ws://localhost/rpc',
  )
  await manager.open(a)
  manager.updateWorktrees([running(a)])
  const page = host.pages[0]
  page.loading.resolve()
  await setImmediate()
  page.prepareForDisconnect = async () => {
    throw new Error('page unavailable')
  }
  const status = withStatus(a, {
    ...running(a).vscode,
    browserPath: `${running(a).vscode.browserPath}-new`,
  })
  manager.updateWorktrees([status])
  await manager.open(a)
  assert.equal(page.disposed, true)
  assert.equal(
    host.pages[1].urls[0],
    `http://localhost${status.vscode.browserPath}`,
  )
  await manager.close()
})

test('shutdown waits for an in-progress replacement save without starting the server', async () => {
  const host = new Host()
  let starts = 0
  const manager = new EditorWindowManager(
    host,
    {
      ensure: async () => {
        starts++
      },
    },
    'ws://localhost/rpc',
  )
  await manager.open(a)
  manager.updateWorktrees([running(a)])
  const page = host.pages[0]
  page.loading.resolve()
  await setImmediate()
  const save = deferred<void>()
  let saves = 0
  page.prepareForDisconnect = () => {
    saves++
    return save.promise
  }
  manager.updateWorktrees([a])
  const opening = manager.open(a)
  const rejected = assert.rejects(opening, /closed/)
  const closing = manager.close()
  assert.equal(saves, 1)
  assert.equal(page.disposed, false)
  assert.equal(host.closed, false)
  save.resolve()
  await Promise.all([closing, rejected])
  assert.equal(starts, 1)
  assert.equal(page.disposed, true)
  assert.equal(host.closed, true)
})

test('shutdown ignores late acknowledgments and page loads', async () => {
  const host = new Host()
  const manager = new EditorWindowManager(
    host,
    { ensure: async () => {} },
    'ws://remote.example/rpc',
  )
  await manager.open(a)
  manager.updateWorktrees([running(a)])
  await manager.close()
  host.pages[0].loading.resolve()
  await setImmediate()
  assert.equal(host.current, undefined)
  await assert.rejects(manager.open(b), /closed/)
})

test('closing before a pending launch prevents new server requests', async () => {
  const host = new Host()
  let starts = 0
  const manager = new EditorWindowManager(
    host,
    {
      ensure: async () => {
        starts++
      },
    },
    'ws://remote.example/rpc',
  )
  const opening = manager.open(a)
  await manager.close()
  await assert.rejects(opening, /closed/)
  assert.equal(starts, 0)
})

test('malformed and off-server browser routes fail without navigating', async () => {
  const host = new Host()
  const manager = new EditorWindowManager(
    host,
    { ensure: async () => {} },
    'ws://remote.example/rpc',
  )
  await manager.open(a)
  manager.updateWorktrees([
    withStatus(a, { ...running(a).vscode, browserPath: 'http://[' }),
  ])
  assert.match(host.state.error!, /Invalid VS Code browser route/)
  manager.updateWorktrees([
    withStatus(a, {
      ...running(a).vscode,
      browserPath: `https://elsewhere.example/vscode/${'a'.repeat(64)}/`,
    }),
  ])
  await manager.retry()
  assert.match(host.state.error!, /Invalid VS Code browser route/)
  assert.equal(host.pages.length, 0)
  await manager.close()
})

test('quitting saves pages concurrently, waits before disposal, and tolerates a failed page', async () => {
  const host = new Host()
  const manager = new EditorWindowManager(
    host,
    { ensure: async () => {} },
    'ws://localhost/rpc',
  )
  await manager.open(a)
  await manager.open(b)
  manager.updateWorktrees([running(a), running(b)])
  const saves = [deferred<void>(), deferred<void>()]
  const started: number[] = []
  host.pages.forEach((page, index) => {
    page.prepareForDisconnect = () => {
      started.push(index)
      return saves[index].promise
    }
  })
  const closing = manager.close()
  assert.equal(manager.close(), closing)
  assert.deepEqual(started, [0, 1])
  assert.ok(host.pages.every((page) => !page.disposed))
  await assert.rejects(manager.open(a), /closed/)
  saves[0].resolve()
  await setImmediate()
  assert.ok(host.pages[0].disposed)
  assert.equal(host.closed, false)
  saves[1].reject(new Error('unresponsive page'))
  await closing
  assert.ok(host.pages.every((page) => page.disposed))
  assert.ok(host.closed)
})

test('every client persists independently after a stopped broadcast and disposes only once', async () => {
  const clients = await Promise.all(
    [0, 1].map(async () => {
      const host = new Host()
      const manager = new EditorWindowManager(
        host,
        { ensure: async () => {} },
        'ws://localhost/rpc',
      )
      await manager.open(a)
      manager.updateWorktrees([running(a)])
      const page = host.pages[0]
      page.loading.resolve()
      await setImmediate()
      const saved = deferred<void>()
      let saves = 0
      page.prepareForDisconnect = () => {
        saves++
        return saved.promise
      }
      return { host, manager, page, saved, saves: () => saves }
    }),
  )
  for (const { manager, page, saves } of clients) {
    manager.updateWorktrees([withStatus(a, { state: 'stopping' })])
    assert.equal(page.disposed, false)
    assert.equal(saves(), 0)
    await assert.rejects(manager.open(a), /stopping/)
    manager.updateWorktrees([a])
    manager.updateWorktrees([a])
    assert.equal(saves(), 1)
    assert.equal(page.disposed, false)
  }
  clients[1].saved.resolve()
  await setImmediate()
  assert.equal(clients[1].page.disposed, true)
  assert.equal(clients[0].page.disposed, false)
  clients[0].saved.resolve()
  await Promise.all(clients.map(({ manager }) => manager.close()))
  assert.ok(clients.every(({ page, saves }) => page.disposed && saves() === 1))
})

test('removal during a pending save prevents reopening', async () => {
  const host = new Host()
  let starts = 0
  const manager = new EditorWindowManager(
    host,
    {
      ensure: async () => {
        starts++
      },
    },
    'ws://localhost/rpc',
  )
  await manager.open(a)
  manager.updateWorktrees([running(a)])
  const page = host.pages[0]
  const saved = deferred<void>()
  let saves = 0
  page.prepareForDisconnect = () => {
    saves++
    return saved.promise
  }
  manager.updateWorktrees([a])
  const opening = manager.open(a)
  const rejected = assert.rejects(opening, /Unknown worktree/)
  manager.updateWorktrees([])
  await manager.retry()
  await assert.rejects(manager.open(a), /Unknown worktree/)
  assert.equal(host.state.canRetry, false)
  assert.match(host.state.error!, /removed/)
  assert.equal(page.disposed, false)
  saved.resolve()
  await rejected
  assert.equal(starts, 1)
  assert.equal(saves, 1)
  assert.match(host.state.error!, /removed/)
  await manager.close()
  assert.equal(page.disposed, true)
})

test('removal while startup is pending ignores late readiness and shutdown waits for local persistence', async () => {
  const host = new Host()
  const ack = deferred<void>()
  const manager = new EditorWindowManager(
    host,
    { ensure: () => ack.promise },
    'ws://localhost/rpc',
  )
  const opening = manager.open(a)
  await setImmediate()
  manager.updateWorktrees([])
  ack.resolve()
  await opening
  manager.updateWorktrees([running(a)])
  assert.equal(host.pages.length, 0)
  await manager.open(a)
  const page = host.pages[0]
  const saved = deferred<void>()
  page.prepareForDisconnect = () => saved.promise
  manager.updateWorktrees([])
  const closing = manager.close()
  assert.equal(host.closed, false)
  assert.equal(page.disposed, false)
  saved.resolve()
  await closing
  assert.equal(page.disposed, true)
  assert.equal(host.closed, true)
})

test('a stopped server remains unavailable while its worktree is being deleted', async () => {
  const host = new Host()
  let starts = 0
  const manager = new EditorWindowManager(
    host,
    {
      ensure: async () => {
        starts++
      },
    },
    'ws://localhost/rpc',
  )
  await manager.open(a)
  manager.updateWorktrees([running(a)])
  manager.updateWorktrees([{ ...a, deleting: true }])
  await setImmediate()
  assert.equal(host.pages[0].disposed, true)
  assert.equal(host.state.canRetry, false)
  await manager.retry()
  await assert.rejects(manager.open(a), /being deleted/)
  assert.equal(starts, 1)
  manager.updateWorktrees([
    { ...a, error: { id: '1', message: 'dirty worktree' } },
  ])
  assert.equal(host.state.canRetry, true)
  await manager.retry()
  assert.equal(starts, 2)
  await manager.close()
})

test('chat launches target the requested loaded page without changing worktree focus', async () => {
  const host = new Host()
  const manager = new EditorWindowManager(
    host,
    { ensure: async () => {} },
    'ws://remote.example/rpc',
  )
  const launch: ChatTerminalLaunch = {
    providerId: 'codex',
    worktreePath: a.path,
    terminalId: 'bcf08308-3214-4d40-8a47-ea183fa95752',
    shellPath: 'codex',
    shellArgs: [],
  }
  await assert.rejects(manager.openChatTerminal(launch), /not open/)
  manager.updateWorktrees([running(a), running(b)])
  await manager.open(a)
  await assert.rejects(manager.openChatTerminal(launch), /not open/)
  host.pages[0].loading.resolve()
  await setImmediate()
  await manager.open(b)
  host.pages[1].loading.resolve()
  await setImmediate()
  await manager.openChatTerminal(launch)
  assert.deepEqual(host.pages[0].launches, [launch])
  assert.deepEqual(host.pages[1].launches, [])
  assert.equal(host.current, host.pages[1])
  await manager.close()
  await assert.rejects(manager.openChatTerminal(launch), /not open/)
})

test('chat focus reaches only the selected ready worktree page', async () => {
  const host = new Host()
  const manager = new EditorWindowManager(
    host,
    { ensure: async () => {} },
    'ws://remote.example/rpc',
  )
  assert.equal(await manager.focusChatTerminal(a.path, 'chat'), false)
  manager.updateWorktrees([running(a), running(b)])
  await manager.open(a)
  assert.equal(await manager.focusChatTerminal(a.path, 'chat'), false)
  host.pages[0].loading.resolve()
  await setImmediate()
  assert.equal(await manager.focusChatTerminal(a.path, 'chat-a'), true)
  await manager.open(b)
  assert.equal(await manager.focusChatTerminal(a.path, 'stale'), false)
  assert.equal(await manager.focusChatTerminal(b.path, 'loading'), false)
  host.pages[1].loading.resolve()
  await setImmediate()
  assert.equal(await manager.focusChatTerminal(b.path, 'chat-b'), true)
  assert.deepEqual(host.pages[0].focused, ['chat-a'])
  assert.deepEqual(host.pages[1].focused, ['chat-b'])
  host.pages[1].crash()
  assert.equal(await manager.focusChatTerminal(b.path, 'failed'), false)
  await manager.close()
  assert.equal(await manager.focusChatTerminal(b.path, 'closed'), false)
})
