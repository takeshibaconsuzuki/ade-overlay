import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import writeFileAtomic from 'write-file-atomic'
import { VscodeSettingsStore } from '../src/server/settings-store'
import { isVscodeSettingsDocument } from '../src/shared/vscode-utils'

async function fixture(t: TestContext, content?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'settings.json')
  if (content !== undefined) await writeFile(path, content)
  const store = await VscodeSettingsStore.open(path)
  t.after(() => store.close())
  const updates: (string | null)[] = []
  store.setOnChangedListener((next) => updates.push(next))
  return { path, store, updates }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Settings update did not arrive')
    await delay(20)
  }
}

test('settings accept JSONC objects and preserve comments, overrides and deletions', async (t) => {
  for (const invalid of ['', '// comment', 'null', '[]', '1', '{', '{"x":NaN}'])
    assert.equal(isVscodeSettingsDocument(invalid), false)
  const content =
    '\uFEFF{\n // keep this\n "[typescript]": {"editor.tabSize": 2},\n "editor.fontSize": 14,\n}\n'
  const { path, store, updates } = await fixture(t, content)
  assert.equal(store.snapshot, content)
  await store.write(content)
  assert.deepEqual(updates, [])
  const replacement = '{\n // only this remains\n "editor.fontSize": 16\n}\n'
  await store.write(replacement)
  assert.equal(await readFile(path, 'utf8'), replacement)
  await delay(250)
  assert.deepEqual(
    updates,
    [replacement],
    'atomic write echoes do not rebroadcast',
  )
  await assert.rejects(store.write('{'), /valid JSONC object/)
  assert.equal(await readFile(path, 'utf8'), replacement)
})

test('external replacements, invalid files, deletion and recreation are observed', async (t) => {
  const { path, store } = await fixture(t, '{}')
  await writeFileAtomic(path, '{"host":1}')
  await waitFor(() => store.snapshot === '{"host":1}')
  await writeFile(path, '{')
  await waitFor(() => store.snapshot === null)
  await assert.rejects(store.write('{"client":1}'), /invalid/)
  assert.equal(
    await readFile(path, 'utf8'),
    '{',
    'invalid host edits are not overwritten',
  )
  await writeFile(path, '{"host":2}')
  await waitFor(() => store.snapshot === '{"host":2}')
  await unlink(path)
  await waitFor(() => store.snapshot === '{}\n')
  await writeFile(path, '{"host":3}')
  await waitFor(() => store.snapshot === '{"host":3}')
})

test('missing host settings start empty and accepted writes are serialized', async (t) => {
  const { path, store } = await fixture(t)
  assert.equal(store.snapshot, '{}\n')
  await Promise.all([store.write('{"first":1}'), store.write('{"last":2}')])
  assert.equal(await readFile(path, 'utf8'), '{"last":2}')
  await store.close()
  await assert.rejects(store.write('{}'), /closed/)
})

test('an invalid initial host document recovers without restarting', async (t) => {
  const { path, store } = await fixture(t, '{')
  assert.equal(store.snapshot, null)
  await writeFile(path, '{"recovered":true}')
  await waitFor(() => store.snapshot === '{"recovered":true}')
})

test('sync observes external edits after creating a previously absent user directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-settings-missing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'Code', 'User', 'settings.json')
  const store = await VscodeSettingsStore.open(path)
  t.after(() => store.close())
  assert.equal(store.snapshot, '{}\n')
  await store.write('{"created":true}')
  await writeFile(path, '{"external":true}')
  await waitFor(() => store.snapshot === '{"external":true}')
})
