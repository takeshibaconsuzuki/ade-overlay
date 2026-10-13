import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { patchVscodeWorkbench } from '../src/server/vscode-workbench-patch'
import { workbenchFixture } from './fixtures/vscode-workbench'
import {
  installAdeHandle,
  type AdeWorkbenchGlobal,
} from '../src/shared/vscode-ade-handle'

function fixture() {
  const context = {} as AdeWorkbenchGlobal & {
    start(): void
    browserMain: { open(): Promise<void> }
    storage: object
    tracker: object
    invocations: number
    started?: boolean
  }
  runInNewContext(`(${installAdeHandle.toString()})()`, context)
  runInNewContext(patchVscodeWorkbench(workbenchFixture), context)
  return context
}

test('the same handle exposes readiness and resolves services after startup', () => {
  const context = fixture()
  const handle = context.adeHandle
  assert.equal(handle.workbenchReady, false)
  assert.throws(() => handle.get('storageService'), /workbench is not ready/)
  context.start()
  assert.equal(context.adeHandle, handle)
  assert.equal(handle.workbenchReady, true)
  assert.equal(handle.get('storageService'), context.storage)
  assert.equal(handle.get('storageService'), context.storage)
  assert.equal(context.invocations, 2)
  assert.equal(
    handle.get('workbench.contrib.browserWorkingCopyBackupTracker'),
    context.tracker,
  )
  assert.throws(() => handle.get('unknown'), /Unknown contribution/)
})

test('patching is idempotent and rejects incompatible or partial bundles', () => {
  const patched = patchVscodeWorkbench(workbenchFixture)
  assert.equal(patchVscodeWorkbench(patched), patched)
  assert.throws(() => patchVscodeWorkbench('unknown bundle'), /does not match/)
  assert.throws(
    () => patchVscodeWorkbench(workbenchFixture.repeat(2)),
    /does not match/,
  )
  assert.throws(
    () =>
      patchVscodeWorkbench(patched.replace('cK.serviceIds.get(id)', 'null')),
    /incomplete/,
  )
})

test('the handle stays unready until initialization succeeds', async () => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  const context = fixture()
  const handle = context.adeHandle
  handle.initializeExtensions = async (storage) => {
    assert.equal(storage, context.storage)
    await pending
  }
  const opening = context.browserMain.open()
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(context.started, undefined)
  assert.equal(handle.workbenchReady, false)
  resolve()
  await opening
  assert.equal(context.started, true)
  assert.equal(handle.workbenchReady, true)
  assert.equal(context.adeHandle, handle)

  const failed = fixture()
  failed.adeHandle.initializeExtensions = async () => {
    throw new Error('Host unavailable')
  }
  await assert.rejects(failed.browserMain.open(), /Host unavailable/)
  assert.equal(failed.started, undefined)
  assert.equal(failed.adeHandle.workbenchReady, false)
})
