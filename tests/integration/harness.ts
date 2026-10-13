import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import electron from 'electron'
import treeKill from 'tree-kill'
import { stringify } from 'yaml'
import { startServer } from '../../src/server/application'
import { ProcessVscodeServerFactory } from '../../src/server/vscode-server'
import { NodeVscodeLauncher } from '../../src/server/vscode-process'
import { DownloadedVscodeRuntime } from '../../src/server/vscode-runtime'
import { FetchHttpClient } from '../../src/shared/http-client'

// Every case uses the pinned runtime with isolated host files and server state.
export async function startIntegrationServer(
  directory: string,
  repos: string[],
) {
  const profileDatabase = join(directory, 'state.vscdb')
  const database = new DatabaseSync(profileDatabase)
  database.exec(
    'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)',
  )
  database.close()
  const config = join(directory, 'server.yaml')
  await writeFile(
    config,
    stringify({
      host: '127.0.0.1',
      port: 0,
      projects: repos.map((mainWorktreePath) => ({ mainWorktreePath })),
      vscode: {
        profileDatabase,
        settingsFile: join(directory, 'settings.json'),
        extensionsDirectory: join(directory, 'extensions'),
      },
    }),
  )
  return startServer(
    config,
    new ProcessVscodeServerFactory(
      new DownloadedVscodeRuntime(new FetchHttpClient(), {
        dataDirectory: join(directory, 'vscode-data'),
      }),
      new NodeVscodeLauncher(),
    ),
    [],
  )
}

// Clients run beside the built desktop entry point, in separate Electron processes.
export async function runDesktopClient(
  name: string,
  environment: NodeJS.ProcessEnv,
  timeout = 60_000,
): Promise<void> {
  const filename = `vscode-${name}-client.mjs`
  const entry = join('out/main', filename)
  await copyFile(join('tests/integration', filename), entry)
  // These scenarios exercise workbenches, not global shortcuts. Leave the user's
  // live picker shortcut alone and allow isolated test clients to start alongside it.
  const bootstrap = join('out/main', `vscode-${name}-bootstrap.mjs`)
  await writeFile(
    bootstrap,
    `import { globalShortcut } from 'electron'
globalShortcut.register = () => true
await import('./${filename}')
`,
  )
  const env = { ...process.env, ...environment }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(electron as unknown as string, [bootstrap], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  const timer = setTimeout(() => {
    if (child.pid) treeKill(child.pid)
  }, timeout)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, `${name} integration client passed`)
  } finally {
    clearTimeout(timer)
  }
}
