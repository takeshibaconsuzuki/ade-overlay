import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  utimes,
  rm,
  realpath,
} from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { SettingsSync } from '../src/server/settings-sync.ts'
import {
  MAX_SETTINGS_BYTES,
  SettingsSnapshot,
} from '../src/shared/editor-settings.ts'
import { silentLogger } from '../src/server/logging.ts'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ade-settings-')))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep))
    assert.ok(root.split(sep).at(-1)?.startsWith('ade-settings-'))
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const path = join(root, 'User', 'settings.json')
  await mkdir(join(root, 'User'))
  return { path, sync: new SettingsSync(path, silentLogger) }
}
const snapshot = (content: string, mtime: number) =>
  new SettingsSnapshot(content, mtime)

test('whole-file newest-wins sync preserves comments, deletions and save time across restarts', async (t) => {
  const { path, sync } = await fixture(t)
  const start = Date.now() - 60_000
  const initial =
    '{\n // Desktop settings\n "editor.fontSize":23, "editor.rulers":[80],\n}\n'
  await writeFile(path, initial)
  await utimes(path, new Date(start), new Date(start))
  assert.equal(
    (await sync.sync(snapshot('{"stale":true}', start - 1000))).content,
    initial,
  )
  const browser =
    '{\n // Entire browser replacement\n "editor.fontSize":29,\n}\n'
  const saved = await sync.sync(snapshot(browser, start + 1000))
  assert.equal(await readFile(path, 'utf8'), browser)
  assert.ok(Math.abs(saved.mtime - (start + 1000)) < 1)
  const restarted = new SettingsSync(path, silentLogger)
  assert.equal(
    (await restarted.sync(snapshot(initial, start))).content,
    browser,
  )
  assert.equal((await restarted.sync(saved)).mtime, saved.mtime)
  const desktop = '{"files.hotExit":"off"}\n'
  await writeFile(path, desktop)
  assert.equal((await restarted.sync(saved)).content, desktop)
})

test('simultaneous clients serialize and an older delayed request cannot overwrite the newest file', async (t) => {
  const { path, sync } = await fixture(t)
  const now = Date.now() - 1000
  await Promise.all([
    sync.sync(snapshot('{"newest":true}', now)),
    sync.sync(snapshot('{"older":true}', now - 100)),
    sync.sync(snapshot('{"tie":true}', now)),
  ])
  assert.equal(await readFile(path, 'utf8'), '{"newest":true}')
  const newerSameContent = await sync.sync(
    snapshot('{"newest":true}', now + 100),
  )
  assert.ok(Math.abs(newerSameContent.mtime - (now + 100)) < 1)
})

test('invalid settings snapshots are rejected and missing files are not seeded by a read', async (t) => {
  const { path, sync } = await fixture(t)
  const missing = await sync.read()
  assert.equal(missing.mtime, 0)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  for (const invalid of [
    { content: '{}', mtime: NaN },
    { content: '{}', mtime: -1 },
    { content: 42, mtime: 0 },
    { content: '{}' },
    { content: '界'.repeat(MAX_SETTINGS_BYTES / 2), mtime: 0 },
  ])
    assert.throws(() => sync.sync(invalid))
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})

test('a desktop save during comparison leaves the browser edit pending for another cycle', async (t) => {
  const { path, sync } = await fixture(t)
  const now = Date.now() - 10_000
  const desktop = '{"desktop":true}'
  await writeFile(path, desktop)
  await utimes(path, new Date(now), new Date(now))
  const read = sync.read.bind(sync)
  const changed = t.mock.method(sync, 'read', async () => {
    changed.mock.restore()
    return snapshot('{"beforeDesktopSave":true}', now - 1000)
  })
  const browser = snapshot('{"newerBrowser":true}', now + 1000)
  await assert.rejects(sync.sync(browser), /changed before writing/)
  assert.equal(await readFile(path, 'utf8'), desktop)
  assert.equal((await sync.sync(browser)).content, browser.content)
  assert.equal((await read()).content, browser.content)
})
