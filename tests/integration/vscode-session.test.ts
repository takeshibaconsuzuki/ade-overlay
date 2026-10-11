import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { simpleGit } from 'simple-git'
import { startIntegrationServer, runDesktopClient } from './harness'

test('VS Code session survives desktop restart', async () => {
  // Runs against the real pinned distribution and two desktop processes with isolated state.
  const directory = await mkdtemp(join(tmpdir(), 'ade-session-scope-'))
  console.log('Session test data:', directory)
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
  const server = await startIntegrationServer(directory, [repo])
  try {
    for (const phase of ['save', 'restore']) {
      await runDesktopClient('session', {
        ADE_SERVER_URL: `ws://127.0.0.1:${server.port}/rpc`,
        ADE_SESSION_DATA: join(directory, 'electron-data'),
        ADE_SESSION_PHASE: phase,
        ADE_SESSION_REPO: repo,
      })
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
})
