import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { patchVscodeWorkbench } from '../src/server/vscode-workbench-patch'
import { workbenchFixture } from './fixtures/vscode-workbench'
import type {
  WorkbenchServices,
  ProfileStorage,
} from '../src/workbench/services'
import { configureWorkbench } from '../src/workbench/layout'

function fixture() {
  const context = {
    hooks: {
      configureWorkbench,
      initializeExtensions: async () => {},
      attachWorkbench: (services: WorkbenchServices) => {
        context.services = services
      },
    },
  } as unknown as {
    hooks: {
      configureWorkbench: typeof configureWorkbench
      initializeExtensions(storage: ProfileStorage): Promise<void>
      attachWorkbench(services: WorkbenchServices): void
    }
    services?: WorkbenchServices
    start(): void
    browserMain: {
      open(): Promise<void>
      initServices(): Promise<unknown>
      configuration: Parameters<typeof configureWorkbench>[0]
    }
    storage: object
    tracker: object
    invocations: number
    started?: boolean
  }
  runInNewContext(
    patchVscodeWorkbench(workbenchFixture).replace(
      /^import .*;\n/,
      'const adeWorkbench = globalThis.hooks;\n',
    ),
    context,
  )
  return context
}

test('the module receives private service access and command registration at startup', () => {
  const context = fixture()
  assert.equal(context.services, undefined)
  context.start()
  const services = context.services!
  assert.equal(services.get('storageService'), context.storage)
  assert.equal(services.get('storageService'), context.storage)
  assert.equal(context.invocations, 2)
  assert.equal(
    services.get('workbench.contrib.browserWorkingCopyBackupTracker'),
    context.tracker,
  )
  assert.throws(() => services.get('unknown'), /Unknown contribution/)
  const registration = services.registerCommand('test', (...args) => args)
  assert.deepEqual(
    Array.from(
      (
        context as unknown as { command(...args: unknown[]): unknown[] }
      ).command({}, 1, 'two'),
    ),
    [1, 'two'],
  )
  registration.dispose()
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

test('the module attaches only after initialization succeeds', async () => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  const context = fixture()
  context.hooks.initializeExtensions = async (storage) => {
    assert.equal(storage, context.storage)
    await pending
  }
  const opening = context.browserMain.open()
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(context.started, undefined)
  assert.equal(context.services, undefined)
  resolve()
  await opening
  assert.equal(context.started, true)
  assert.ok(context.services)

  const failed = fixture()
  failed.hooks.initializeExtensions = async () => {
    throw new Error('Host unavailable')
  }
  await assert.rejects(failed.browserMain.open(), /Host unavailable/)
  assert.equal(failed.started, undefined)
  assert.equal(failed.services, undefined)
})

test('layout defaults are supplied before configuration services initialize', async () => {
  const context = fixture()
  context.browserMain.configuration.configurationDefaults = {
    'editor.fontSize': 16,
  }
  const initialize = context.browserMain.initServices
  context.browserMain.initServices = function () {
    const options = this.configuration
    assert.deepEqual(
      Array.from(options.defaultLayout!.views!, (view) => view.id),
      ['ade.sidebar'],
    )
    assert.equal('force' in options.defaultLayout!, false)
    assert.equal(options.configurationDefaults!['editor.fontSize'], 16)
    assert.equal(
      options.configurationDefaults!['workbench.sideBar.location'],
      'left',
    )
    assert.equal(
      options.configurationDefaults![
        'workbench.secondarySideBar.defaultVisibility'
      ],
      'hidden',
    )
    assert.deepEqual(
      options.configurationDefaults!['terminal.integrated.commandsToSkipShell'],
      [
        '-workbench.action.terminal.scrollUpPage',
        '-workbench.action.terminal.scrollDownPage',
      ],
    )
    return initialize.call(this)
  }
  await context.browserMain.open()
  assert.equal(context.started, true)
})
