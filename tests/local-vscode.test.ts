import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test, type TestContext } from 'node:test'
import { load } from 'cheerio'
import { parse } from 'jsonc-parser'
import {
  importLocalVSCode,
  prepareEditorSettings,
} from '../src/server/local-vscode.ts'
import { withImportedProfile } from '../src/server/editor-page.ts'
import { localVSCodeFixture } from './fixtures/local-vscode.ts'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ade-import-')))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep))
    assert.ok(root.split(sep).at(-1)?.startsWith('ade-import-'))
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return {
    root,
    dataDir: join(root, 'data'),
    config: await localVSCodeFixture(root),
  }
}

test('new profiles import keybindings without copying settings into either server scope', async (t) => {
  const { root, dataDir, config } = await fixture(t)
  const source = join(config.localUserDataDir, 'User', 'settings.json')
  const original = await readFile(source, 'utf8')
  const imported = await importLocalVSCode(config, undefined)
  const template = JSON.parse(imported.profile!.contents)
  assert.deepEqual(JSON.parse(template.settings), { settings: '{}\n' })
  assert.equal(
    JSON.parse(JSON.parse(template.keybindings).keybindings)[0].command,
    'ade.checkImport',
  )
  const workspace = join(root, 'workspace')
  await prepareEditorSettings(workspace, dataDir)
  await assert.rejects(readFile(join(workspace, 'User', 'settings.json')), {
    code: 'ENOENT',
  })
  assert.deepEqual(
    parse(await readFile(join(workspace, 'Machine', 'settings.json'), 'utf8')),
    { 'terminal.integrated.enablePersistentSessions': true },
  )
  assert.equal(await readFile(source, 'utf8'), original)
  await assert.rejects(readFile(join(dataDir, 'local-import.json')), {
    code: 'ENOENT',
  })
})

test('legacy imports are backed up and removed once, preserving edited Remote overrides', async (t) => {
  const { root, dataDir } = await fixture(t)
  const workspace = join(root, 'workspace')
  await mkdir(dataDir)
  await writeFile(
    join(dataDir, 'local-import.json'),
    JSON.stringify({
      settings: {
        'editor.fontSize': 23,
        'editor.rulers': [80],
        'files.hotExit': 'onExit',
      },
    }),
  )
  for (const folder of ['User', 'Machine']) {
    await mkdir(join(workspace, folder), { recursive: true })
    await writeFile(
      join(workspace, folder, 'settings.json'),
      '{\n // Keep my font override\n "editor.fontSize": 29, "editor.rulers": [80], "files.hotExit": "onExit",\n}',
    )
  }
  const path = join(workspace, 'Machine', 'settings.json')
  const original = await readFile(path, 'utf8')
  await prepareEditorSettings(workspace, dataDir)
  assert.deepEqual(parse(await readFile(path, 'utf8')), {
    'editor.fontSize': 29,
    'terminal.integrated.enablePersistentSessions': true,
  })
  assert.match(await readFile(path, 'utf8'), /Keep my font override/)
  assert.equal(await readFile(path + '.before-settings-sync', 'utf8'), original)
  await writeFile(
    path,
    '{"editor.fontSize":23,"terminal.integrated.enablePersistentSessions":false}',
  )
  await prepareEditorSettings(workspace, dataDir)
  assert.deepEqual(parse(await readFile(path, 'utf8')), {
    'editor.fontSize': 23,
    'terminal.integrated.enablePersistentSessions': true,
  })
})

test('profile import handles missing local data', async (t) => {
  const { root } = await fixture(t)
  const imported = await importLocalVSCode(
    { localUserDataDir: join(root, 'missing') },
    undefined,
  )
  const template = JSON.parse(imported.profile!.contents)
  assert.deepEqual(JSON.parse(template.settings), { settings: '{}\n' })
  assert.equal(template.keybindings, undefined)
  assert.deepEqual(await importLocalVSCode({}, undefined), {})
})

test('Remote persistence accepts empty settings and leaves malformed settings untouched', async (t) => {
  const { root, dataDir } = await fixture(t)
  const workspace = join(root, 'workspace')
  await prepareEditorSettings(workspace, dataDir)
  const path = join(workspace, 'Machine', 'settings.json')
  await writeFile(path, '// Remote overrides\n')
  await prepareEditorSettings(workspace, dataDir)
  const content = await readFile(path, 'utf8')
  assert.match(content, /Remote overrides/)
  assert.equal(
    parse(content)['terminal.integrated.enablePersistentSessions'],
    true,
  )
  await writeFile(path, '{"unfinished":')
  await assert.rejects(
    prepareEditorSettings(workspace, dataDir),
    /invalid VS Code Remote settings/,
  )
  assert.equal(await readFile(path, 'utf8'), '{"unfinished":')
})

test('page injection preserves scripts and CSP nonce while safely encoding profile data', () => {
  const profile = {
    name: '',
    contents: JSON.stringify({ keybindings: '<script>alert("x")</script>&\'' }),
  }
  const script = 'globalThis.example = "<x>&";'
  const html = `<!DOCTYPE html><html><head><meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;localhost:1234&quot;}"></head><body><script nonce="test-nonce">${script}</script></body></html>`
  const page = load(
    withImportedProfile(html, profile, '/editors/example/ade-settings-sync.js'),
  )
  const config = JSON.parse(
    page('#vscode-workbench-web-configuration').attr('data-settings')!,
  )
  assert.deepEqual(config, { remoteAuthority: 'localhost:1234', profile })
  assert.equal(page('script:not([src])').text(), script)
  assert.equal(page('script[src]').attr('nonce'), 'test-nonce')
  assert.equal(
    page('script[src]').attr('src'),
    '/editors/example/ade-settings-sync.js',
  )
  assert.throws(
    () => withImportedProfile('<html></html>', profile),
    /workbench configuration/,
  )
})
