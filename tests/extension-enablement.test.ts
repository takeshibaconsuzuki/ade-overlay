import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { readDisabledExtensions } from '../src/server/extension-enablement'

test('host snapshots read committed changes without changing the profile database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-enablement-'))
  const path = join(directory, 'state.vscdb')
  const database = new DatabaseSync(path)
  t.after(async () => {
    database.close()
    await rm(directory, { recursive: true, force: true })
  })
  database.exec('PRAGMA journal_mode=WAL')
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
  assert.deepEqual(readDisabledExtensions(path), [])
  const write = database.prepare(
    'INSERT OR REPLACE INTO ItemTable VALUES (?, ?)',
  )
  const key = 'extensionsIdentifiers/disabled'
  write.run(
    key,
    JSON.stringify([{ id: 'publisher.extension', uuid: 'identity' }]),
  )
  const before = await readFile(path)
  assert.deepEqual(readDisabledExtensions(path), [
    { id: 'publisher.extension', uuid: 'identity' },
  ])
  assert.deepEqual(await readFile(path), before)
  write.run(key, '[]')
  assert.deepEqual(readDisabledExtensions(path), [])
  for (const value of ['{', '{}', '[{"id":""}]', '[{"id":4}]']) {
    write.run(key, value)
    assert.throws(
      () => readDisabledExtensions(path),
      /Unable to read host extension enablement/,
    )
  }
  assert.throws(
    () => readDisabledExtensions(join(directory, 'missing.vscdb')),
    /Unable to read host extension enablement/,
  )
  await assert.rejects(readFile(join(directory, 'missing.vscdb')), {
    code: 'ENOENT',
  })
})
