import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import electron from 'electron'
import treeKill from 'tree-kill'
import { stringify } from 'yaml'
import { startServer } from '../../src/server/application'
import { ProcessVscodeServerManager } from '../../src/server/vscode-manager'
import { NodeVscodeLauncher } from '../../src/server/vscode-process'
import { DownloadedVscodeRuntime } from '../../src/server/vscode-runtime'
import { FetchHttpClient } from '../../src/shared/http-client'

// Every case uses the pinned runtime with isolated host files and server state.
export async function startIntegrationServer(
  directory: string,
  repos: string[],
) {
  const config = join(directory, 'server.yaml')
  await writeFile(
    config,
    stringify({
      host: '127.0.0.1',
      port: 0,
      projects: repos.map((mainWorktreePath) => ({ mainWorktreePath })),
      vscode: {
        settingsFile: join(directory, 'settings.json'),
        extensionsDirectory: join(directory, 'extensions'),
      },
    }),
  )
  return startServer(
    config,
    new ProcessVscodeServerManager(
      new DownloadedVscodeRuntime(new FetchHttpClient(), {
        dataDirectory: join(directory, 'vscode-data'),
      }),
      new NodeVscodeLauncher(),
    ),
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
  const env = { ...process.env, ...environment }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(electron as unknown as string, [entry], {
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
