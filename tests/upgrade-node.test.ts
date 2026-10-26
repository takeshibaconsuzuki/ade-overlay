import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { upgradeNode } from '../scripts/upgrade-node'
import type { HttpClient } from '../src/shared/http-client'

test('Node upgrade selects the newest release on the pinned major', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-node-upgrade-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pinFile = join(directory, '.node-version')
  await writeFile(pinFile, '24.9.0\n')
  const http: HttpClient = {
    fetch: async (url, options) => {
      assert.equal(url, 'https://nodejs.org/dist/index.json')
      assert.ok(options?.signal)
      return Response.json(
        ['26.12.1', '24.22.0', '24.9.0', '24.22.1', '22.23.4'].map(
          (version) => ({ version: `v${version}` }),
        ),
      )
    },
  }
  await upgradeNode(http, pinFile)
  assert.equal(await readFile(pinFile, 'utf8'), '24.22.1\n')
})

test('Node upgrade preserves the pin on failure and never downgrades', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-node-upgrade-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pinFile = join(directory, '.node-version')
  const original = '24.22.1\n'
  await writeFile(pinFile, original)
  for (const response of [
    new Response(null, { status: 503 }),
    Response.json([{ version: 'invalid' }]),
    Response.json([{ version: 'v24.23.0-rc.1' }]),
    Response.json([{ version: 'v26.12.1' }]),
    Response.json([]),
  ]) {
    const http: HttpClient = { fetch: async () => response }
    await assert.rejects(upgradeNode(http, pinFile))
    assert.equal(await readFile(pinFile, 'utf8'), original)
  }
  for (const version of ['v24.22.1', 'v24.21.0']) {
    await upgradeNode(
      { fetch: async () => Response.json([{ version }]) },
      pinFile,
    )
    assert.equal(await readFile(pinFile, 'utf8'), original)
  }
})
