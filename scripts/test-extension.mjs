import assert from 'node:assert/strict'
import {
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTests } from '@vscode/test-electron'
import { build } from 'vite'
import { ChatService } from '../src/server/chats/chat-service.ts'
import { installProviderHooks } from '../src/server/chats/chat-hooks.ts'
import { codexProvider } from '../src/server/chats/chat-providers.ts'
import { vscodeRelease } from '../src/server/editors/vscode-release.ts'

const root = await mkdtemp(join(tmpdir(), 'ade-extension-'))
const chats = new ChatService()
const control = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/disconnect')
    chats.releaseEditor('extension-test')
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(chats.store.list()))
})
try {
  const extension = join(root, 'extension')
  const testModules = join(extension, 'out')
  await mkdir(testModules, { recursive: true })
  for (const asset of [
    'package.json',
    'media',
    'out/sidebar.js',
    'out/sidebar.css',
  ]) {
    await cp(
      new URL(`../extensions/ade-terminals/${asset}`, import.meta.url),
      join(extension, asset),
      { recursive: true },
    )
  }
  const sidebarScript = join(testModules, 'sidebar.js')
  const browserBundle = await readFile(sidebarScript)
  // Share module instances with the activation under test: the chat module
  // consumes its private bootstrap credential once when it is first loaded.
  await build({
    configFile: false,
    resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
    build: {
      target: 'node22',
      outDir: testModules,
      emptyOutDir: false,
      lib: {
        entry: Object.fromEntries(
          [
            'extension',
            'launcher',
            'chats',
            'terminal-identities',
            'sidebar',
          ].map((name) => [
            name === 'sidebar' ? 'sidebar-host' : name,
            fileURLToPath(
              new URL(
                `../extensions/ade-terminals/src/${name}.ts`,
                import.meta.url,
              ),
            ),
          ]),
        ),
        formats: ['cjs'],
        fileName: (_format, name) => `${name}.js`,
      },
      rollupOptions: {
        output: { chunkFileNames: '[name]-[hash].js' },
        external: [
          'vscode',
          /^node:/,
          ...builtinModules,
          'bufferutil',
          'utf-8-validate',
        ],
      },
    },
  })
  assert.ok(
    (await readFile(sidebarScript)).equals(browserBundle),
    'The extension-host test build must preserve the sidebar browser bundle',
  )
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
    fileURLToPath(new URL('../src/server/chats/chat-hook.ts', import.meta.url)),
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
  const { activityEnvironment: chatEnvironment, controlToken } =
    chats.registerEditor('extension-test', {
      project: workspace,
      path: workspace,
    })
  await runTests({
    version: vscodeRelease.version,
    vscodeExecutablePath: process.env.ADE_TEST_VSCODE_EXECUTABLE,
    extensionDevelopmentPath: extension,
    extensionTestsPath: fileURLToPath(
      new URL('../tests/runtime/ade-terminals.cjs', import.meta.url),
    ),
    launchArgs: [
      workspace,
      `--user-data-dir=${join(root, 'user-data')}`,
      `--extensions-dir=${join(root, 'extensions')}`,
      '--disable-extensions',
      '--disable-gpu',
      `--extensionEnvironment=${JSON.stringify({ ADE_CHAT_EXTENSION_TOKEN: controlToken })}`,
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
