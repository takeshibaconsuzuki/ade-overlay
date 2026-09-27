import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTests } from '@vscode/test-electron'

const root = await mkdtemp(join(tmpdir(), 'ade-extension-'))
try {
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await mkdir(join(root, 'user-data', 'User'), { recursive: true })
  await writeFile(
    join(root, 'user-data', 'User', 'settings.json'),
    JSON.stringify({
      'adeTerminals.codexCommand': 'echo codex > ade-codex.txt',
      'adeTerminals.claudeCommand': 'echo claude > ade-claude.txt',
      'terminal.integrated.tabs.title': '${process}',
      'security.workspace.trust.enabled': false,
      'workbench.startupEditor': 'none',
      'window.restoreWindows': 'none',
      'telemetry.telemetryLevel': 'off',
    }),
  )
  await runTests({
    vscodeExecutablePath: process.env.ADE_TEST_VSCODE_EXECUTABLE,
    extensionDevelopmentPath: fileURLToPath(
      new URL('../extensions/ade-terminals/', import.meta.url),
    ),
    extensionTestsPath: fileURLToPath(
      new URL('../tests/fixtures/ade-terminals.cjs', import.meta.url),
    ),
    launchArgs: [
      workspace,
      `--user-data-dir=${join(root, 'user-data')}`,
      `--extensions-dir=${join(root, 'extensions')}`,
      '--disable-extensions',
      '--disable-gpu',
    ],
    extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined },
  })
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  assert.ok(root.split(sep).at(-1)?.startsWith('ade-extension-'))
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  })
}
