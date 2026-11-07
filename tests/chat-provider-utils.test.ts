import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { readJsonLines } from '../src/server/chat-providers/utils'

test('JSON Lines records skip lines that are not JSON, including one still being written', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-jsonl-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'records.jsonl')
  await writeFile(path, '{"a":1}\r\nnot JSON\n\n[2]\n{"unfinished":')
  assert.deepEqual(await Readable.from(readJsonLines(path)).toArray(), [
    { a: 1 },
    [2],
  ])
  assert.deepEqual(
    await Readable.from(
      readJsonLines(join(directory, 'missing.jsonl')),
    ).toArray(),
    [],
  )
})
