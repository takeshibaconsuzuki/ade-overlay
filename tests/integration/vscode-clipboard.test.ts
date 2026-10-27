import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { simpleGit } from 'simple-git'
import { runDesktopClient, startIntegrationServer } from './harness'

test('terminal OSC 52 writes the desktop clipboard through the browser workbench', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-clipboard-integration-'))
  const repo = join(directory, 'repo')
  await mkdir(repo)
  await mkdir(join(directory, 'extensions'))
  await simpleGit(repo).init()
  const cli = join(directory, 'clipboard.cjs')
  await writeFile(
    cli,
    `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { target, text, terminator, marker } = JSON.parse(line);
  process.stdout.write('\\x1b]52;' + target + ';' + Buffer.from(text).toString('base64') + terminator + '\\r\\n' + marker + '\\r\\n');
});
console.log('CLIPBOARD_READY');
`,
  )
  const server = await startIntegrationServer(directory, [repo])
  try {
    await runDesktopClient('clipboard', {
      ADE_SERVER_URL: `ws://127.0.0.1:${server.port}/rpc`,
      ADE_CLIPBOARD_DATA: directory,
      ADE_CLIPBOARD_NODE: process.execPath,
      ADE_CLIPBOARD_CLI: cli,
    })
  } finally {
    await server.close()
  }
})
