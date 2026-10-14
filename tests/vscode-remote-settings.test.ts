import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { parse } from 'jsonc-parser'
import { prepareVscodeRemoteSettings } from '../src/server/vscode-remote-settings'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-remote-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return {
    directory,
    path: join(directory, 'data', 'Machine', 'settings.json'),
  }
}

test('remote settings enable persistence before the first connection', async (t) => {
  const { directory, path } = await fixture(t)
  await prepareVscodeRemoteSettings(directory)
  assert.deepEqual(parse(await readFile(path, 'utf8')), {
    'terminal.integrated.enablePersistentSessions': true,
  })
})

test('preparation preserves other remote settings and JSONC comments across restarts', async (t) => {
  const { directory, path } = await fixture(t)
  await mkdir(dirname(path), { recursive: true })
  const content =
    '\uFEFF{\n  // Keep remote preferences.\n  "editor.fontSize": 18,\n  "terminal.integrated.enablePersistentSessions": false,\n}\n'
  await writeFile(path, content)
  await prepareVscodeRemoteSettings(directory)
  const prepared = await readFile(path, 'utf8')
  assert.equal(prepared, content.replace('false', 'true'))
  await prepareVscodeRemoteSettings(directory)
  assert.equal(await readFile(path, 'utf8'), prepared)
})

test('invalid remote settings are reported without overwriting the file', async (t) => {
  const { directory, path } = await fixture(t)
  await mkdir(dirname(path), { recursive: true })
  const content = '{"editor.fontSize":'
  await writeFile(path, content)
  await assert.rejects(
    prepareVscodeRemoteSettings(directory),
    /Invalid VS Code remote settings/,
  )
  assert.equal(await readFile(path, 'utf8'), content)
})
