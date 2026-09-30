import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

test('terminal launches require one folder and use project chat commands or defaults', async (t) => {
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
  const registrations: unknown[][] = []
  const launcher = new TerminalLauncher({
    register: (...args: unknown[]) => registrations.push(args),
    id: () => undefined,
    onDidChange: () => ({ dispose() {} }),
  })
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
  const previous = process.env.ADE_CHAT_COMMANDS
  t.after(() => {
    if (previous === undefined) delete process.env.ADE_CHAT_COMMANDS
    else process.env.ADE_CHAT_COMMANDS = previous
  })
  for (const overrides of [
    undefined,
    {},
    { codex: "custom-codex --no-daemon --profile 'my project'" },
    { claude: 'custom-claude --verbose' },
  ]) {
    if (overrides === undefined) delete process.env.ADE_CHAT_COMMANDS
    else process.env.ADE_CHAT_COMMANDS = JSON.stringify(overrides)
    for (const kind of ['codex', 'claude'] as const) {
      const chat = await launcher.open(kind)
      assert.equal(registrations.at(-1)?.[0], chat)
      assert.equal(registrations.at(-1)?.[2], kind)
      assert.equal(chat.creationOptions.cwd, folder.uri)
      assert.equal(chat.creationOptions.iconPath.id, 'comment-discussion')
      const command =
        overrides?.[kind] ?? (kind === 'codex' ? 'codex --no-daemon' : 'claude')
      assert.deepEqual(chat.sentText, [`{\n${command}\n}; exit`])
    }
  }
  const terminal = await launcher.open('terminal')
  assert.equal(terminal.creationOptions.cwd, folder.uri)
  assert.equal(terminal.creationOptions.iconPath.id, 'terminal')
  assert.ok(vscode.effects.includes('createTerminal'))
  assert.deepEqual(terminal.sentText, [])
  process.env.ADE_CHAT_COMMANDS = '{"codex":" "}'
  const effects = vscode.effects.length
  await assert.rejects(
    launcher.open('codex'),
    /Chat commands must not be blank/,
  )
  assert.equal(vscode.effects.length, effects)
})
