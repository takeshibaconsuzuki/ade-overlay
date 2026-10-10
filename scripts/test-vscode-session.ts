import assert from 'node:assert/strict'
import treeKill from 'tree-kill'
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import electron from 'electron'
import { simpleGit } from 'simple-git'
import { stringify } from 'yaml'
import { startServer } from '../src/server/application'
import { ProcessVscodeServerManager } from '../src/server/vscode-manager'
import { NodeVscodeLauncher } from '../src/server/vscode-process'
import { DownloadedVscodeRuntime } from '../src/server/vscode-runtime'
import { FetchHttpClient } from '../src/shared/http-client'

// Runs against the real pinned distribution and two desktop processes with isolated state.
const directory = await mkdtemp(join(tmpdir(), 'ade-session-scope-'))
console.log('Session test data:', directory)
await copyFile(
  'tests/integration/vscode-session-client.mjs',
  'out/main/vscode-session-client.mjs',
)
const repo = join(directory, 'alpha')
await mkdir(join(repo, '.vscode'), { recursive: true })
await simpleGit(repo).init()
await writeFile(join(repo, 'hello.txt'), 'Hello\nSecond line\nThird line\n')
await writeFile(
  join(repo, '.vscode/settings.json'),
  JSON.stringify({
    'terminal.integrated.defaultProfile.windows': 'ADE Test',
    'terminal.integrated.profiles.windows': {
      'ADE Test': {
        path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: ['-NoLogo', '-NoProfile'],
      },
    },
  }),
)
const config = join(directory, 'server.yaml')
await writeFile(
  config,
  stringify({
    host: '127.0.0.1',
    port: 0,
    projects: [{ mainWorktreePath: repo }],
  }),
)
const runtime = new DownloadedVscodeRuntime(new FetchHttpClient(), {
  dataDirectory: join(directory, 'vscode-data'),
})
const manager = new ProcessVscodeServerManager(
  runtime,
  new NodeVscodeLauncher(),
)
const server = await startServer(config, manager)
try {
  for (const phase of ['save', 'restore']) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ADE_SERVER_URL: `ws://127.0.0.1:${server.port}/rpc`,
      ADE_SESSION_DATA: join(directory, 'electron-data'),
      ADE_SESSION_PHASE: phase,
      ADE_SESSION_REPO: repo,
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const child = spawn(
      electron as unknown as string,
      ['out/main/vscode-session-client.mjs'],
      { env, stdio: 'inherit', windowsHide: true },
    )
    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid)
    }, 60000)
    const [code] = await once(child, 'exit')
    clearTimeout(timer)
    if (code !== 0) {
      process.exitCode = 1
      break
    }
    if (phase === 'save') {
      const pid = Number(
        (await readFile(join(repo, 'save.txt'), 'utf8')).trim().split(' ')[0],
      )
      assert.doesNotThrow(
        () => process.kill(pid, 0),
        'terminal stays alive between desktop processes',
      )
    }
  }
} finally {
  await server.close()
}
