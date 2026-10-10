import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { upgradeVscode } from '../scripts/upgrade-vscode'
import { vscodePlatform } from '../src/server/vscode-runtime'
import type { HttpClient } from '../src/shared/http-client'

test('upgrade pins the latest stable version and commit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-vscode-upgrade-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pinFile = join(directory, 'vscode-server.json')
  const http: HttpClient = {
    fetch: async (url, options) => {
      assert.equal(
        url,
        `https://update.code.visualstudio.com/api/latest/${vscodePlatform()}/stable`,
      )
      assert.ok(options?.signal)
      return Response.json({ name: '1.142.0', version: 'a'.repeat(40) })
    },
  }
  await upgradeVscode(http, pinFile)
  assert.deepEqual(JSON.parse(await readFile(pinFile, 'utf8')), {
    version: '1.142.0',
    commit: 'a'.repeat(40),
  })
})

test('failed or invalid release lookup preserves the existing pin', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-vscode-upgrade-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pinFile = join(directory, 'vscode-server.json')
  const original = '{"version":"1.141.0","commit":"original"}\n'
  await writeFile(pinFile, original)
  for (const response of [
    new Response(null, { status: 503 }),
    Response.json({ name: '1.142.0', version: 'invalid' }),
  ]) {
    const http: HttpClient = { fetch: async () => response }
    await assert.rejects(upgradeVscode(http, pinFile))
    assert.equal(await readFile(pinFile, 'utf8'), original)
  }
})
