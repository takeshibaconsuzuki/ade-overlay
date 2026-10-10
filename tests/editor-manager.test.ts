import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  EditorWindowManager,
  type EditorHost,
  type EditorPage,
} from '../src/desktop/main/editor-manager'
import type { EditorState } from '../src/desktop/api'
import type { VscodeServerStatus, Worktree } from '../src/shared/api'

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
  readonly loading = deferred<void>()
  urls: string[] = []
  disposed = false
  constructor(readonly crash: () => void) {}
  load(url: string): Promise<void> {
    this.urls.push(url)
    return this.loading.promise
  }
  dispose(): void {
    this.disposed = true
  }
}

class Host implements EditorHost {
  pages: Page[] = []
  current: EditorPage | undefined
  state: EditorState = { title: '' }
  shown = 0
  closed = false
  showAndFocusWindow(): void {
    this.shown++
  }
  createPage(_key: string, crash: () => void): Page {
    const page = new Page(crash)
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

const a: Worktree = { path: '/repo/a', basename: 'a', branchName: 'a' }
const b: Worktree = { path: '/repo/b', basename: 'b', branchName: 'b' }
function running(worktree: Worktree): VscodeServerStatus {
  return {
    path: worktree.path,
    state: 'running',
    browserPath: `/vscode/${'a'.repeat(64)}/?tkn=secret`,
  }
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
  manager.updateStatuses([running(a)])
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
  manager.close()
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
  manager.updateStatuses([running(a), running(b)])
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
  manager.updateStatuses([
    {
      path: a.path,
      state: 'stopped',
      error: { id: '1', message: 'server exited' },
    },
  ])
  assert.equal(host.current, host.pages[0])
  assert.equal(host.state.error, undefined)
  manager.close()
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
  manager.updateStatuses([
    {
      path: a.path,
      state: 'stopped',
      error: { id: '1', message: 'launch failed' },
    },
  ])
  assert.equal(host.state.error, 'launch failed')
  manager.updateStatuses([running(a)])
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
  manager.close()
})

test('shutdown ignores late acknowledgments and page loads', async () => {
  const host = new Host()
  const manager = new EditorWindowManager(
    host,
    { ensure: async () => {} },
    'ws://remote.example/rpc',
  )
  await manager.open(a)
  manager.updateStatuses([running(a)])
  manager.close()
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
  manager.close()
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
  manager.updateStatuses([{ ...running(a), browserPath: 'http://[' }])
  assert.match(host.state.error!, /Invalid VS Code browser route/)
  manager.updateStatuses([
    {
      ...running(a),
      browserPath: `https://elsewhere.example/vscode/${'a'.repeat(64)}/`,
    },
  ])
  await manager.retry()
  assert.match(host.state.error!, /Invalid VS Code browser route/)
  assert.equal(host.pages.length, 0)
  manager.close()
})
