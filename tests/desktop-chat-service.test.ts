import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  DesktopChatService,
  type ChatEditor,
} from '../src/desktop/chat-service'
import type { Chat, Worktree } from '../src/shared/api'

const terminalId = 'bcf08308-3214-4d40-8a47-ea183fa95752'
const worktree: Worktree = {
  path: '/repo',
  basename: 'repo',
  branchName: 'main',
  mainWorktreePath: '/repo',
  deleting: false,
  vscode: { path: '/repo', state: 'running' },
}
const chat: Chat = {
  providerId: 'test',
  sessionId: 'one',
  worktreePath: '/repo',
  terminalId,
  title: 'Chat',
  status: 'idle',
  mtime: 0,
  pid: 1,
}
class Editor implements ChatEditor {
  opened: Worktree[] = []
  launched: unknown[] = []
  attempts: string[] = []
  focused: string[] = []
  ready = false
  acceptance = Promise.resolve()
  async open(value: Worktree) {
    this.opened.push(value)
    await this.acceptance
  }
  async openChatTerminal(value: unknown) {
    this.launched.push(value)
  }
  async focusChatTerminal(_path: string, id: string) {
    this.attempts.push(id)
    if (this.ready) this.focused.push(id)
    return this.ready
  }
}
function fixture(t: TestContext) {
  const editor = new Editor()
  const service = new DesktopChatService(editor)
  service.updateChats({ one: chat })
  service.updateWorktrees([worktree])
  t.after(() => service.disconnect())
  return { editor, service }
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected focus did not arrive')
    await delay(10)
  }
}

test('chat opening validates snapshots and awaits acceptance before retrying focus', async (t) => {
  const { service, editor } = fixture(t)
  let accept!: () => void
  editor.acceptance = new Promise<void>((resolve) => {
    accept = resolve
  })
  let completed = false
  const opening = service.openChat('one').then(() => {
    completed = true
  })
  await delay(0)
  assert.deepEqual(editor.opened, [worktree])
  assert.equal(completed, false)
  assert.deepEqual(editor.attempts, [])
  accept()
  await opening
  await waitFor(() => editor.attempts.length >= 2)
  editor.ready = true
  await waitFor(() => editor.focused.length === 1)
  assert.deepEqual(editor.focused, [terminalId])
  await assert.rejects(service.openChat('missing'), /no longer available/)
  service.updateWorktrees([{ ...worktree, deleting: true }])
  await assert.rejects(service.openChat('one'), /being deleted/)
  service.updateWorktrees([])
  await assert.rejects(service.openChat('one'), /Unknown worktree/)
})

test('terminal launch validates arguments and resolves server paths independently of desktop OS', async (t) => {
  const { service, editor } = fixture(t)
  const windows = { ...worktree, path: 'C:\\Repo' }
  service.updateWorktrees([windows])
  const options = {
    terminalId,
    providerId: 'codex',
    worktreePath: 'c:/repo',
    shellPath: 'pwsh',
    shellArgs: [],
  }
  await service.openChatTerminal(options)
  assert.deepEqual(editor.launched, [
    { ...options, worktreePath: windows.path },
  ])
  await assert.rejects(
    service.openChatTerminal({ ...options, terminalId: 'invalid' }),
  )
  await assert.rejects(
    service.openChatTerminal({ ...options, worktreePath: '/unknown' }),
    /Unknown worktree/,
  )
  service.updateWorktrees([{ ...windows, deleting: true }])
  await assert.rejects(service.openChatTerminal(options), /being deleted/)
})

for (const cancellation of [
  'new selection',
  'ownership change',
  'disconnect',
  'worktree removed',
  'chat removed',
]) {
  test(`focus retry is cancelled on ${cancellation}`, async (t) => {
    const { service, editor } = fixture(t)
    await service.openChat('one')
    await waitFor(() => editor.attempts.length === 1)
    if (cancellation === 'new selection') {
      service.updateChats({ one: chat, two: { ...chat, terminalId: 'second' } })
      await service.openChat('two')
    } else if (cancellation === 'ownership change')
      service.updateChats({ one: { ...chat, terminalId: undefined } })
    else if (cancellation === 'chat removed') service.updateChats({})
    else if (cancellation === 'worktree removed') service.updateWorktrees([])
    else service.disconnect()
    editor.ready = true
    await delay(350)
    assert.deepEqual(
      editor.focused,
      cancellation === 'new selection' ? ['second'] : [],
    )
  })
}

test('external chats open without focus and failed acceptance cancels pending selection', async (t) => {
  const { service, editor } = fixture(t)
  service.updateChats({ one: { ...chat, terminalId: undefined } })
  await service.openChat('one')
  assert.deepEqual(editor.attempts, [])
  editor.acceptance = Promise.reject(new Error('startup failed'))
  service.updateChats({ one: chat })
  await assert.rejects(service.openChat('one'), /startup failed/)
  editor.ready = true
  await delay(300)
  assert.deepEqual(editor.focused, [])
})
