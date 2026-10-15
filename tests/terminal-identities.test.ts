import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  TerminalIdentities,
  type ChatTerminal,
  type TerminalIdentityStore,
  type ChatTerminalIdentity,
} from '../vscode-extension/src/terminal-identities'

class Store implements TerminalIdentityStore {
  writes: Record<string, ChatTerminalIdentity>[] = []
  constructor(private saved: Record<string, ChatTerminalIdentity> = {}) {}
  read() {
    return { ...this.saved }
  }
  async write(identities: Record<string, ChatTerminalIdentity>) {
    this.writes.push(identities)
  }
}

class Terminal implements ChatTerminal {
  shown = 0
  resolve!: (pid: number | undefined) => void
  processId = new Promise<number | undefined>((resolve) => {
    this.resolve = resolve
  })
  show() {
    this.shown++
  }
}

test('failed PID acquisition cannot block another terminal or resurrect a closed terminal', async (t) => {
  const store = new Store()
  const identities = new TerminalIdentities(store)
  t.after(() => identities.dispose())
  const failed = new Terminal()
  const live = new Terminal()
  identities.track(failed, { id: 'failed', providerId: 'codex' })
  identities.track(live, { id: 'live', providerId: 'codex' })
  live.resolve(123)
  await setImmediate()
  assert.equal(identities.focus('live'), true)
  assert.equal(live.shown, 1)
  assert.deepEqual(store.writes, [{ 123: { id: 'live', providerId: 'codex' } }])
  assert.deepEqual(identities.forProcess(123), {
    id: 'live',
    providerId: 'codex',
  })
  identities.forget(failed)
  failed.resolve(456)
  await setImmediate()
  assert.equal(identities.focus('failed'), false)
  identities.forget(live)
  assert.equal(identities.focus('live'), false)
  await setImmediate()
  assert.deepEqual(store.writes.at(-1), {})
})

test('restored terminals resolve independently of unrelated unresolved processes', async (t) => {
  const identities = new TerminalIdentities(
    new Store({ 123: { id: 'restored', providerId: 'codex' } }),
  )
  t.after(() => identities.dispose())
  const unrelated = new Terminal()
  const restored = new Terminal()
  identities.track(unrelated, undefined)
  identities.track(restored, undefined)
  assert.equal(identities.focus('restored'), false)
  restored.resolve(123)
  await setImmediate()
  assert.equal(identities.focus('restored'), true)
  assert.deepEqual(identities.forProcess(123), {
    id: 'restored',
    providerId: 'codex',
  })
  identities.forget(unrelated)
  assert.equal(identities.focus('restored'), true)
})

test('unowned terminals are skipped when there are no saved identities', () => {
  const identities = new TerminalIdentities(new Store())
  identities.track(
    {
      get processId(): Promise<number> {
        throw new Error('PID must not be requested')
      },
      show() {
        assert.fail('Unowned terminal focused')
      },
    },
    undefined,
  )
  identities.dispose()
})

test('PID acquisition expires and disposal cancels outstanding registrations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = new Store()
  const identities = new TerminalIdentities(store)
  const expired = new Terminal()
  identities.track(expired, { id: 'expired', providerId: 'codex' })
  t.mock.timers.tick(10_000)
  await setImmediate()
  expired.resolve(123)
  await setImmediate()
  assert.equal(identities.focus('expired'), false)
  const disposed = new Terminal()
  identities.track(disposed, { id: 'disposed', providerId: 'codex' })
  identities.dispose()
  disposed.resolve(456)
  await setImmediate()
  assert.equal(identities.focus('disposed'), false)
  assert.deepEqual(store.writes, [])
})
