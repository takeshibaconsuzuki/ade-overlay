import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  TerminalIdentities,
  type ChatTerminal,
  type TerminalIdentityStore,
} from '../vscode-extension/src/terminal-identities'

class Store implements TerminalIdentityStore {
  writes: Record<string, string>[] = []
  constructor(private saved: Record<string, string> = {}) {}
  read() {
    return { ...this.saved }
  }
  async write(identities: Record<string, string>) {
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
  identities.track(failed, 'failed')
  identities.track(live, 'live')
  live.resolve(123)
  await setImmediate()
  assert.equal(identities.focus('live'), true)
  assert.equal(live.shown, 1)
  assert.deepEqual(store.writes, [{ 123: 'live' }])
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
  const identities = new TerminalIdentities(new Store({ 123: 'restored' }))
  t.after(() => identities.dispose())
  const unrelated = new Terminal()
  const restored = new Terminal()
  identities.track(unrelated, undefined)
  identities.track(restored, undefined)
  assert.equal(identities.focus('restored'), false)
  restored.resolve(123)
  await setImmediate()
  assert.equal(identities.focus('restored'), true)
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
  identities.track(expired, 'expired')
  t.mock.timers.tick(10_000)
  await setImmediate()
  expired.resolve(123)
  await setImmediate()
  assert.equal(identities.focus('expired'), false)
  const disposed = new Terminal()
  identities.track(disposed, 'disposed')
  identities.dispose()
  disposed.resolve(456)
  await setImmediate()
  assert.equal(identities.focus('disposed'), false)
  assert.deepEqual(store.writes, [])
})
