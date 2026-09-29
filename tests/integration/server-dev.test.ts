import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setImmediate as tick } from 'node:timers/promises'
import { build } from 'vite'

const fixtureUrl = new URL(
  '../fixtures/development-launcher.mjs',
  import.meta.url,
)
const fixture = await import(fixtureUrl.href)
let root: string
let run = 0
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ade-dev-launcher-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'launcher-dependencies',
        enforce: 'pre',
        resolveId: (id) =>
          [
            'node:process',
            'node:child_process',
            './settings-bridge-build.mjs',
            '../src/shared/node/process-lifecycle.ts',
          ].includes(id)
            ? { id: fixtureUrl.href, external: true }
            : undefined,
      },
    ],
    build: {
      target: 'node22',
      outDir: root,
      lib: {
        entry: fileURLToPath(
          new URL('../../scripts/server-dev.mjs', import.meta.url),
        ),
        formats: ['es'],
        fileName: () => 'server-dev.mjs',
      },
    },
  })
})
after(async () => {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  await rm(root, { recursive: true, force: true })
})

async function start(platform = 'linux', holdCreation = false) {
  fixture.reset(platform)
  const finished = import(
    `${pathToFileURL(join(root, 'server-dev.mjs')).href}?run=${++run}`
  )
  // Tests inspect failures after releasing their controlled lifecycle events.
  void finished.catch(() => {})
  await fixture.state.created.promise
  if (!holdCreation) {
    fixture.state.creating.resolve()
    await tick()
  }
  return { finished }
}

function cleaned() {
  assert.equal(fixture.state.closes, 1)
  assert.equal(fixture.watcher.listenerCount('event'), 0)
  assert.equal(fixture.launcherProcess.listenerCount('SIGINT'), 0)
  assert.equal(fixture.launcherProcess.listenerCount('SIGTERM'), 0)
}

for (const phase of ['creation', 'build', 'completion']) {
  test(
    `development shutdown during ${phase} never launches a companion`,
    { timeout: 5000 },
    async () => {
      const { finished } = await start('linux', phase === 'creation')
      if (phase === 'completion') fixture.watcher.emit('event', { code: 'END' })
      fixture.launcherProcess.emit('SIGTERM')
      fixture.launcherProcess.emit('SIGINT')
      fixture.state.creating.resolve()
      await finished
      fixture.watcher.emit('event', { code: 'END' })
      assert.deepEqual(fixture.state.launches, [])
      cleaned()
    },
  )
}

test('development build failure releases startup subscriptions and closes its watcher', async () => {
  const { finished } = await start()
  const error = new Error('fixture build failure')
  fixture.watcher.emit('event', { code: 'ERROR', error })
  await assert.rejects(finished, (actual) => actual === error)
  assert.deepEqual(fixture.state.launches, [])
  cleaned()
})

for (const platform of ['linux', 'win32']) {
  test(
    `development shutdown awaits child exit on ${platform}`,
    { timeout: 5000 },
    async () => {
      const { finished } = await start(platform)
      fixture.watcher.emit('event', { code: 'END' })
      await fixture.state.spawned.promise
      assert.equal(fixture.watcher.listenerCount('event'), 0)
      assert.deepEqual(fixture.state.launches[0][1].slice(-2), [
        '--config',
        'fixture.yaml',
      ])
      let complete = false
      void finished.then(() => {
        complete = true
      })
      fixture.launcherProcess.emit('SIGTERM')
      assert.equal(
        await fixture.state.stopping.promise,
        platform === 'win32' ? 'tree' : 'SIGTERM',
      )
      await tick()
      assert.equal(
        complete,
        false,
        'accepted work must drain before the launcher exits',
      )
      fixture.child.finish(0)
      await finished
      assert.equal(fixture.launcherProcess.exitCode, 0)
      cleaned()
    },
  )
}

test('development launcher preserves child failure and still cleans up', async () => {
  const { finished } = await start()
  fixture.watcher.emit('event', { code: 'END' })
  await fixture.state.spawned.promise
  fixture.child.finish(7)
  await finished
  assert.equal(fixture.launcherProcess.exitCode, 7)
  cleaned()
})

test('a watcher close failure does not prevent stopping the companion', async () => {
  const { finished } = await start()
  fixture.watcher.emit('event', { code: 'END' })
  await fixture.state.spawned.promise
  const error = new Error('fixture close failure')
  fixture.state.closeError = error
  let complete = false
  const rejected = assert.rejects(finished, (actual) => actual === error)
  void rejected.then(() => {
    complete = true
  })
  fixture.launcherProcess.emit('SIGTERM')
  assert.equal(await fixture.state.stopping.promise, 'SIGTERM')
  await tick()
  assert.equal(complete, false)
  fixture.child.finish(0)
  await rejected
  cleaned()
})
