import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { simpleGit } from 'simple-git'
import { startIntegrationServer, runDesktopClient } from './harness'

test('startup imports enablement before activation and preserves workspace overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-enablement-integration-'))
  console.log('Enablement test data:', directory)
  const repo = join(directory, 'repo')
  await mkdir(repo)
  await simpleGit(repo).init()
  const extension = join(directory, 'extensions', 'ade-test.enablement-1.0.0')
  await mkdir(extension, { recursive: true })
  await writeFile(
    join(extension, 'package.json'),
    JSON.stringify({
      name: 'enablement',
      publisher: 'ade-test',
      version: '1.0.0',
      engines: { vscode: '^1.100.0' },
      main: './extension.js',
      activationEvents: ['*'],
      capabilities: { untrustedWorkspaces: { supported: true } },
    }),
  )
  await writeFile(
    join(extension, 'extension.js'),
    `exports.activate = () => require('node:fs').appendFileSync(${JSON.stringify(join(directory, 'activations'))}, '+');`,
  )
  const server = await startIntegrationServer(directory, [repo])
  const database = new DatabaseSync(join(directory, 'state.vscdb'))
  const update = database.prepare(
    'INSERT OR REPLACE INTO ItemTable VALUES (?, ?)',
  )
  const disabled = '[{"id":"ade-test.enablement"}]'
  update.run('extensionsIdentifiers/disabled', disabled)
  const control = createServer((request, response) => {
    const values: Record<string, string> = {
      '/enable': '[]',
      '/disable': disabled,
      '/invalid': '{',
    }
    const value = values[request.url ?? '']
    if (value === undefined) {
      response.writeHead(404).end()
      return
    }
    update.run('extensionsIdentifiers/disabled', value)
    response.end('ok')
  })
  try {
    control.listen(0, '127.0.0.1')
    await once(control, 'listening')
    const address = control.address()
    assert.ok(address && typeof address !== 'string')
    await runDesktopClient(
      'enablement',
      {
        ADE_SERVER_URL: `ws://127.0.0.1:${server.port}/rpc`,
        ADE_ENABLEMENT_DATA: directory,
        ADE_ENABLEMENT_CONTROL: `http://127.0.0.1:${address.port}`,
      },
      120_000,
    )
    assert.equal(
      database
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('extensionsIdentifiers/disabled')?.value,
      disabled,
      'ADE never writes host enablement',
    )
  } finally {
    control.closeAllConnections()
    control.close()
    database.close()
    await server.close()
  }
})
