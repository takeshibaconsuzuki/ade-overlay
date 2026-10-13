import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import {
  persistVscodeSession,
  type SessionServices,
} from '../src/desktop/editor/vscode/vscode-session'
import type { AdeHandle } from '../src/shared/vscode-ade-handle'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class Session {
  readonly pending = new Map([
    ['native backup', {}],
    ['native deletion', {}],
  ])
  readonly writes = deferred()
  readonly flush = deferred()
  flushed = false
  joined = 0
  readonly services = {
    storageService: {
      flush: async (reason: 1) => {
        assert.equal(reason, 1)
        this.flushed = true
        await this.flush.promise
      },
    } satisfies SessionServices.StorageService,
    workingCopyBackupService: {
      joinBackups: async () => {
        this.joined++
        await this.writes.promise
      },
    } satisfies SessionServices.WorkingCopyBackupService,
    'workbench.contrib.browserWorkingCopyBackupTracker': {
      pendingBackupOperations: this.pending,
    } satisfies SessionServices.WorkingCopyBackupTracker,
  }
  readonly handle: AdeHandle = {
    workbenchReady: true,
    get: (id) => this.services[id as keyof typeof this.services],
  }
  // Drive the page's polling timer explicitly; native operations retain ownership of the map.
  private tick: (() => void) | undefined
  settled = false
  start(): Promise<AggregateError | undefined> {
    return runInNewContext(`(${persistVscodeSession.toString()})()`, {
      adeHandle: this.handle,
      setTimeout: (callback: () => void) => {
        this.tick = callback
      },
    }).then(
      () => {
        this.settled = true
      },
      (error: AggregateError) => {
        this.settled = true
        return error
      },
    )
  }
  async poll(): Promise<void> {
    const tick = this.tick
    this.tick = undefined
    tick?.()
    await setImmediate()
  }
}

test('flushes the view while waiting for native backups, deletions and queued writes', async () => {
  const session = new Session()
  const saving = session.start()
  session.flush.resolve()
  await setImmediate()
  assert.equal(session.flushed, true)
  assert.equal(session.joined, 0)
  assert.equal(session.pending.size, 2, 'ADE must not cancel native operations')
  assert.equal(session.settled, false)
  session.pending.delete('native backup')
  await session.poll()
  assert.equal(
    session.joined,
    0,
    'a deletion for an already-clean file must finish too',
  )
  session.pending.delete('native deletion')
  await session.poll()
  assert.equal(session.joined, 1)
  assert.equal(
    session.settled,
    false,
    'queued writes may outlive tracker entries',
  )
  session.writes.resolve()
  assert.equal(await saving, undefined)
})

test('notices native work scheduled while writes are draining', async () => {
  const session = new Session()
  session.pending.clear()
  session.flush.resolve()
  const saving = session.start()
  assert.equal(session.joined, 1)
  session.pending.set('new backup', {})
  session.writes.resolve()
  await setImmediate()
  assert.equal(session.settled, false)
  session.pending.clear()
  await session.poll()
  assert.equal(await saving, undefined)
  assert.equal(session.joined, 2)
})

test('a failed flush does not interrupt native work and failures are reported together', async () => {
  const session = new Session()
  const flushError = new Error('view flush failed')
  const backupError = new Error('backup queue failed')
  const saving = session.start()
  session.flush.reject(flushError)
  await setImmediate()
  assert.equal(session.settled, false)
  session.pending.clear()
  await session.poll()
  session.writes.reject(backupError)
  const error = await saving
  assert.ok(error)
  assert.deepEqual(Array.from(error.errors), [flushError, backupError])
})

test('an idle tracker requires no polling delay', async () => {
  const session = new Session()
  session.pending.clear()
  session.flush.resolve()
  session.writes.resolve()
  assert.equal(await session.start(), undefined)
  assert.equal(session.joined, 1)
})
