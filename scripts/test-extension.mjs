import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTests } from '@vscode/test-electron'
import { ChatService } from '../src/server/chat-service.ts'
import { installProviderHooks } from '../src/server/chat-hooks.ts'
import { codexProvider } from '../src/server/chat-providers.ts'

const root = await mkdtemp(join(tmpdir(), 'ade-extension-'))
const chats = new ChatService()
const control = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(chats.store.list()))
})
try {
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await chats.listen()
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve))
  chats.onNavigate = (id) => chats.viewReady(id)
  const provider = join(
    root,
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  )
  await copyFile(process.execPath, provider)
  const hookFile = join(root, 'hooks.json')
  await installProviderHooks(
    codexProvider,
    hookFile,
    fileURLToPath(new URL('../src/server/chat-hook.ts', import.meta.url)),
  )
  const quote = (text) =>
    process.platform === 'win32'
      ? `'${text.replaceAll("'", "''")}'`
      : `'${text.replaceAll("'", "'\\''")}'`
  const command =
    (process.platform === 'win32' ? '& ' : '') +
    [
      provider,
      fileURLToPath(
        new URL('../tests/fixtures/chat-provider.mjs', import.meta.url),
      ),
    ]
      .map(quote)
      .join(' ')
  const holdCommand = (kind) =>
    (process.platform === 'win32' ? '& ' : '') +
    [
      process.execPath,
      fileURLToPath(
        new URL('../tests/fixtures/chat-launcher.mjs', import.meta.url),
      ),
      kind,
    ]
      .map(quote)
      .join(' ')
  await mkdir(join(root, 'user-data', 'User'), { recursive: true })
  await writeFile(
    join(root, 'user-data', 'User', 'settings.json'),
    JSON.stringify({
      'adeTerminals.codexCommand': holdCommand('codex'),
      'adeTerminals.claudeCommand': holdCommand('claude'),
      'terminal.integrated.tabs.title': '${process}',
      'security.workspace.trust.enabled': false,
      'workbench.startupEditor': 'none',
      'window.restoreWindows': 'none',
      'telemetry.telemetryLevel': 'off',
    }),
  )
  const chatEnvironment = chats.environment('extension-test', {
    project: workspace,
    path: workspace,
  })
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
      `--extensionEnvironment=${JSON.stringify({ ADE_CHAT_EXTENSION_TOKEN: chats.extensionToken('extension-test') })}`,
    ],
    extensionTestsEnv: {
      ELECTRON_RUN_AS_NODE: undefined,
      ...chatEnvironment,
      ADE_CHAT_TEST_CONTROL: `http://127.0.0.1:${control.address().port}`,
      ADE_CHAT_TEST_HOOKS: hookFile,
      ADE_CHAT_TEST_PROVIDER_COMMAND: command,
    },
  })
} finally {
  await chats.close()
  await new Promise((resolve) => control.close(resolve))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  assert.ok(root.split(sep).at(-1)?.startsWith('ade-extension-'))
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  })
}
