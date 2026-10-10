import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { patchVscodeWorkbench } from '../src/server/vscode-workbench-patch'
import { workbenchFixture } from './fixtures/vscode-workbench'
import type { AdeWorkbenchGlobal } from '../src/shared/vscode-ade-handle'

test('the ADE handle resolves services with fresh accessors and contributions by name', () => {
  const context = {} as AdeWorkbenchGlobal & {
    start(): void
    storage: object
    tracker: object
    invocations: number
  }
  runInNewContext(patchVscodeWorkbench(workbenchFixture), context)
  assert.equal(context.getAdeHandle, undefined)
  context.start()
  const handle = context.getAdeHandle()
  assert.equal(context.getAdeHandle(), handle)
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
