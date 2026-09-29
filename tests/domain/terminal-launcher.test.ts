import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

test('terminal launch requires one folder before any workbench change and uses it as cwd', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ade-launcher-'))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  })
  const fixture = new URL('../fixtures/launcher-vscode.mjs', import.meta.url)
    .href
  await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'vscode-fixture',
        resolveId: (id) =>
          id === 'vscode' ? { id: fixture, external: true } : undefined,
      },
    ],
    build: {
      target: 'node22',
      outDir: root,
      lib: {
        entry: fileURLToPath(
          new URL(
            '../../extensions/ade-terminals/src/launcher.ts',
            import.meta.url,
          ),
        ),
        formats: ['es'],
        fileName: () => 'launcher.mjs',
      },
      rollupOptions: { external: [/^node:/] },
    },
  })
  const vscode = await import(fixture)
  const { TerminalLauncher } = await import(
    pathToFileURL(join(root, 'launcher.mjs')).href
  )
  const launcher = new TerminalLauncher(() => {})
  t.after(() => launcher.dispose())
  const folder = { uri: { fsPath: '/worktree' } }
  for (const folders of [undefined, [], [folder, folder]]) {
    vscode.workspace.workspaceFolders = folders
    for (const kind of ['terminal', 'codex', 'claude']) {
      await assert.rejects(launcher.open(kind), /exactly one workspace folder/)
      assert.deepEqual(vscode.effects, [])
    }
  }
  vscode.workspace.workspaceFolders = [folder]
  const terminal = await launcher.open('terminal')
  assert.equal(terminal.creationOptions.cwd, folder.uri)
  assert.ok(vscode.effects.includes('createTerminal'))
})
