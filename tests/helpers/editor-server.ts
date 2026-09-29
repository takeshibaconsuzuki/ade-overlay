import { editorPath } from '../../src/shared/companion.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { TestContext } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CompanionClient } from '../../src/main/companion-client.ts'
import { FixtureRuntime } from '../fixtures/editor-runtime.ts'
import { type EditorSession } from '../../src/shared/companion.ts'

const execute = promisify(execFile)

export async function fixture(t: TestContext, startupDelayMs = 0) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ade-editors-')))
  const runtimePath = join(root, 'runtime')
  await mkdir(join(runtimePath, 'out'), { recursive: true })
  await copyFile(
    process.execPath,
    join(runtimePath, process.platform === 'win32' ? 'node.exe' : 'node'),
  )
  // A real child process and sockets exercise startup, authentication, exit,
  // concurrent opens and shutdown without downloading an editor in unit tests.
  await writeFile(
    join(runtimePath, 'out', 'server-main.js'),
    `
    const { createServer } = require('node:http');
    const { readFileSync } = require('node:fs');
    const { WebSocketServer } = require(${JSON.stringify(fileURLToPath(import.meta.resolve('ws')))});
    const { parseCookie } = require(${JSON.stringify(fileURLToPath(import.meta.resolve('cookie')))});
    const args = Object.fromEntries(process.argv.slice(2).flatMap((value, i, values) => value.startsWith('--') ? [[value, values[i + 1]]] : []));
    const token = readFileSync(args['--connection-token-file'], 'utf8');
    const server = createServer((req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      if (parseCookie(req.headers.cookie || '')['vscode-tkn'] !== token) { res.writeHead(403); res.end(); return; }
      if (req.url.includes('/crash')) { res.end(); setTimeout(() => process.exit(1), 20); return; }
      if (req.url.includes('/release-cwd')) process.chdir(args['--server-data-dir']);
      if (req.headers.accept === 'text/html') {
        const config = JSON.stringify({ remoteAuthority: req.headers['x-forwarded-host'] || req.headers.host, cookie: req.headers.cookie }).replaceAll('"', '&quot;');
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Set-Cookie', 'vscode-tkn=' + token + '; SameSite=Lax');
        res.end('<html><head><meta id="vscode-workbench-web-configuration" data-settings="' + config + '"></head><body></body></html>');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ args, pid: process.pid, cookie: req.headers.cookie, authorization: req.headers.authorization, runtime: process.argv[1], companionCredentialPresent: Object.keys(process.env).some(name => name.toUpperCase() === 'ADE_COMPANION_TOKEN'), profileOverridePresent: Object.keys(process.env).some(name => ['VSCODE_PORTABLE', 'VSCODE_APPDATA'].includes(name.toUpperCase())) }));
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => {
      ws.on('message', data => ws.send(data));
      if (req.url.endsWith('/cookie-check')) ws.send(JSON.stringify({ cookie: req.headers.cookie, authorization: req.headers.authorization }));
    }));
    console.log('stdout token sample: ' + token);
    console.error('stderr token sample: ' + token);
    setTimeout(() => server.listen(0, '127.0.0.1', () => console.log('Extension host agent listening on ' + server.address().port)), ${startupDelayMs});
  `,
  )
  const project = join(root, 'project with spaces')
  await mkdir(project)
  await execute('git', ['-C', project, 'init', '--initial-branch=main'])
  await execute('git', [
    '-C',
    project,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--no-gpg-sign',
    '--allow-empty',
    '-m',
    'Initial',
  ])
  const dataDir = join(root, 'editor data')
  const cleanups: (() => Promise<void>)[] = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    const temp = await realpath(tmpdir())
    assert.ok(resolve(root).startsWith(resolve(temp) + sep))
    assert.ok(root.split(sep).at(-1)?.startsWith('ade-editors-'))
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  })
  return {
    root,
    project,
    cleanups,
    editorRuntime: new FixtureRuntime(root, runtimePath),
    config: {
      projects: [{ mainWorktreePath: project }],
      editor: {
        dataDir,
        localExtensionsDir: join(root, 'local extensions'),
      },
    },
  }
}

export async function connect(t: TestContext, url: string) {
  const client = new CompanionClient({ url, requestTimeoutMs: 10_000 })
  const connected = new Promise<void>((resolve) =>
    client.on('status', (status) => {
      if (status.state === 'connected') resolve()
    }),
  )
  t.after(() => client.stop())
  client.connect()
  await connected
  return client
}

export function editorUrl(companion: string, session: EditorSession) {
  return new URL(editorPath(session.id), companion.replace('ws:', 'http:')).href
}
