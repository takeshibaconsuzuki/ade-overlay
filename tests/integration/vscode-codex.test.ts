import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { test } from 'node:test'
import { simpleGit } from 'simple-git'
import { connectRpc } from '../../src/shared/rpc-client'
import type { DesktopClientMethods, ServerMethods } from '../../src/shared/api'
import { TestChatProvider } from '../fixtures/chat-provider'
import { runDesktopClient, startIntegrationServer } from './harness'

async function runChatScenario(phases: string[]): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ade-codex-integration-'))
  console.log('Codex test data:', directory)
  const repo = join(directory, 'repo')
  const bin = join(directory, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  if (phases.includes('sole-group'))
    await writeFile(
      join(repo, 'notes.txt'),
      'A normal editor after closing chats.\n',
    )
  const settings = '{"terminal.integrated.enablePersistentSessions":false}\n'
  await writeFile(join(directory, 'settings.json'), settings)
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
  // A second desktop must not make extension actions ambiguous or receive them.
  const otherDesktop = connectRpc<ServerMethods, DesktopClientMethods>(
    `ws://127.0.0.1:${server.port}/rpc`,
    {
      getClientInfo: () => ({
        kind: 'desktop',
        name: 'other desktop',
        version: '1',
      }),
      chatsChanged() {},
      settingsChanged() {},
      worktreesChanged() {},
      chatTurnFinished() {},
    },
  )
  try {
    for (const phase of phases) {
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
    assert.equal(
      await readFile(join(directory, 'settings.json'), 'utf8'),
      settings,
    )
  } finally {
    process.env.PATH = previousPath
    await otherDesktop.close()
    await server.close()
  }
}

test('closing the last chat releases the sole editor group', () =>
  runChatScenario(['sole-group']))

test('Codex button opens locked terminals, chat rows focus them, and command exit closes them', () =>
  runChatScenario(['launch', 'restore', 'close-restored']))
