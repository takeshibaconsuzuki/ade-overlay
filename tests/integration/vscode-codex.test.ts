import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { test } from 'node:test'
import { simpleGit } from 'simple-git'
import { TestChatProvider } from '../fixtures/chat-provider'
import { runDesktopClient, startIntegrationServer } from './harness'

test('Codex button opens locked terminals, chat rows focus them, and command exit closes them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-codex-integration-'))
  console.log('Codex test data:', directory)
  const repo = join(directory, 'repo')
  const bin = join(directory, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  await simpleGit(repo).init()
  const extension = join(directory, 'extensions', 'ade.ade-0.1.0')
  await mkdir(extension, { recursive: true })
  for (const name of ['package.json', 'out', 'media']) {
    await cp(resolve('vscode-extension', name), join(extension, name), {
      recursive: true,
    })
  }
  // A fixture CLI exercises the real PTY and shell without starting a paid session.
  const cli = join(bin, 'codex.cjs')
  await writeFile(
    cli,
    `
    const fs = require('node:fs');
    const id = process.env.ADE_TERMINAL_ID;
    fs.writeFileSync(id + '.json', JSON.stringify({ id, pid: process.pid, cwd: process.cwd() }));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', data => process.exit(data.toString().includes('x') ? 7 : 0));
    console.log('CODEX_READY');
  `,
  )
  await writeFile(
    join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    process.platform === 'win32'
      ? `@"${process.execPath}" "${cli}"\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\"'\"'")}' '${cli.replaceAll("'", "'\"'\"'")}'\n`,
    { mode: 0o755 },
  )
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${previousPath}`
  const server = await startIntegrationServer(
    directory,
    [repo],
    [new TestChatProvider()],
  )
  try {
    for (const phase of ['launch', 'restore', 'close-restored']) {
      await runDesktopClient(
        'codex',
        {
          ADE_SERVER_URL: `ws://127.0.0.1:${server.port}/rpc`,
          ADE_CODEX_DATA: directory,
          ADE_CODEX_REPO: repo,
          ADE_CODEX_PHASE: phase,
        },
        120_000,
      )
    }
  } finally {
    process.env.PATH = previousPath
    await server.close()
  }
})
