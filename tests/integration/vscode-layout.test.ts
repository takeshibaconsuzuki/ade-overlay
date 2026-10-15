import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { simpleGit } from 'simple-git'
import { runDesktopClient, startIntegrationServer } from './harness'

test('initial layout opens ADE and preserves later layout choices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-layout-integration-'))
  const repo = join(directory, 'repo')
  await mkdir(repo)
  await simpleGit(repo).init()
  const extension = join(directory, 'extensions', 'ade.ade-0.1.0')
  await mkdir(extension, { recursive: true })
  for (const name of ['package.json', 'out', 'media']) {
    await cp(resolve('vscode-extension', name), join(extension, name), {
      recursive: true,
    })
  }
  // Keep the disposable extension enabled while this case exercises layout restoration.
  const manifestPath = join(extension, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.capabilities = { untrustedWorkspaces: { supported: true } }
  await writeFile(manifestPath, JSON.stringify(manifest))
  const server = await startIntegrationServer(directory, [repo])
  try {
    await runDesktopClient('layout', {
      ADE_SERVER_URL: `ws://127.0.0.1:${server.port}/rpc`,
      ADE_LAYOUT_DATA: join(directory, 'electron-data'),
    })
  } finally {
    await server.close()
  }
})
