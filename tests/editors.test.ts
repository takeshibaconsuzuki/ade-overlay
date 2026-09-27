import {
  completeCreate,
  completeDelete,
} from './helpers/worktree-operations.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { Server, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'
import pino from 'pino'
import { load } from 'cheerio'
import { parseCookie } from 'cookie'
import { parse } from 'jsonc-parser'
import {
  prepareTerminalSerialization,
  validateTerminalSerialization,
} from '../src/server/terminal-serialization.ts'
import { Writable } from 'node:stream'
import { WebSocket } from 'ws'
import { CompanionClient } from '../src/main/companion-client.ts'
import { startCompanionServer } from '../src/server/server.ts'
import { FixtureRuntime } from './fixtures/editor-runtime.ts'
import { localVSCodeFixture } from './fixtures/local-vscode.ts'
import { bundleMain } from './fixtures/bundle-main.ts'
import { loadServerConfig } from '../src/server/config.ts'
import { SettingsSnapshot } from '../src/shared/editor-settings.ts'
import {
  parseClientMessage,
  parseServerMessage,
  type EditorSession,
  type WorktreeUpdate,
} from '../src/shared/companion.ts'

const execute = promisify(execFile)

async function fixture(t: TestContext, startupDelayMs = 0) {
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

async function connect(t: TestContext, url: string) {
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

function editorUrl(companion: string, session: EditorSession) {
  return new URL(session.path, companion.replace('ws:', 'http:')).href
}

test('editor commands validate inputs and status in worktree responses', () => {
  assert.equal(
    parseClientMessage(
      JSON.stringify({
        type: 'editor:open',
        id: '1',
        input: { project: 'repo', path: '\0' },
      }),
    ),
    null,
  )
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: 'editor',
        id: '1',
        session: { id: 'x', path: 'https://evil.test' },
      }),
    ),
    null,
  )
})

test('editor config paths resolve relative to YAML and reject invalid fields', async (t) => {
  const { root } = await fixture(t)
  const file = join(root, 'server.yaml')
  await writeFile(
    file,
    'projects: []\neditor:\n  dataDir: ./data\n  reconnectionGraceSeconds: 600\n  localUserDataDir: ./local\n  localExtensionsDir: ./extensions\n',
  )
  assert.deepEqual((await loadServerConfig(file)).editor, {
    dataDir: join(root, 'data'),
    reconnectionGraceSeconds: 600,
    localUserDataDir: join(root, 'local'),
    localExtensionsDir: join(root, 'extensions'),
  })
  await writeFile(file, 'projects: []\neditor:\n  dataDir: 3\n')
  await assert.rejects(loadServerConfig(file), /Invalid config/)
  for (const seconds of [0, -1, 0.5, 2_147_484]) {
    await writeFile(
      file,
      `projects: []\neditor:\n  reconnectionGraceSeconds: ${seconds}\n`,
    )
    await assert.rejects(loadServerConfig(file), /Invalid config/)
  }
  await writeFile(file, 'projects: []\neditor:\n  runtimePath: ./runtime\n')
  await assert.rejects(loadServerConfig(file), /Unrecognized key/)
})

test('imported root pages retain authentication, public authority and VS Code cookies', async (t) => {
  const {
    project,
    root,
    config: baseConfig,
    cleanups,
    editorRuntime,
  } = await fixture(t)
  const config = {
    ...baseConfig,
    editor: { ...baseConfig.editor, ...(await localVSCodeFixture(root)) },
  }
  const server = await startCompanionServer({ port: 0, config, editorRuntime })
  cleanups.push(() => server.close())
  const client = await connect(t, server.url)
  const session = await client.openEditor({ project, path: project })
  const url = editorUrl(server.url, session)
  assert.equal(
    (await fetch(url, { headers: { Accept: 'text/html' } })).status,
    403,
  )
  for (const external of [undefined, 'editor.example.test']) {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html',
        Authorization: `Bearer ${session.accessToken}`,
        ...(external ? { 'X-Forwarded-Host': external } : {}),
      },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.ok(response.headers.getSetCookie()[0].startsWith('vscode-tkn='))
    const page = load(await response.text())
    const settings = JSON.parse(
      page('#vscode-workbench-web-configuration').attr('data-settings')!,
    )
    assert.equal(settings.remoteAuthority, external ?? new URL(url).host)
    assert.equal(settings.profile.name, '')
    assert.deepEqual(
      JSON.parse(JSON.parse(settings.profile.contents).settings),
      { settings: '{}\n' },
    )
    assert.equal(page('script[src$="ade-settings-sync.js"]').length, 1)
  }
  const syncUrl = new URL('ade-settings-sync', url)
  assert.equal(
    (await fetch(syncUrl, { method: 'POST', body: '{}' })).status,
    403,
  )
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
  }
  assert.equal(
    (await fetch(syncUrl, { method: 'POST', headers, body: '{}' })).status,
    400,
  )
  const text = '{}\n'
  const synced = await fetch(syncUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(new SettingsSnapshot(text, 0)),
  })
  assert.equal(synced.status, 200)
  const snapshot = await synced.json()
  assert.equal(
    snapshot.content,
    await readFile(
      join(config.editor.localUserDataDir, 'User', 'settings.json'),
      'utf8',
    ),
  )
  assert.equal(typeof snapshot.mtime, 'number')
  const script = await fetch(new URL('ade-settings-sync.js', url), { headers })
  assert.equal(script.status, 200)
  assert.match(await script.text(), /vscode.indexedDB.vscode-userdata.changes/)
})

test('editor proxy preserves preference cookies and replaces all stale authentication cookies', async (t) => {
  const { project, config, cleanups, editorRuntime } = await fixture(t)
  const server = await startCompanionServer({ port: 0, config, editorRuntime })
  cleanups.push(() => server.close())
  const client = await connect(t, server.url)
  const editor = await client.openEditor({ project, path: project })
  const url = editorUrl(server.url, editor)
  const cookie =
    'vscode-tkn=old; vscode.nls.locale=fr; preference=%2Ffoo%3Dbar; empty=; vscode-tkn=another-old'
  const headers = {
    Authorization: `Bearer ${editor.accessToken}`,
    Cookie: cookie,
  }
  const check = (value: string) => {
    assert.deepEqual(
      { ...parseCookie(value, { decode: (value) => value }) },
      {
        'vscode-tkn': editor.accessToken,
        'vscode.nls.locale': 'fr',
        preference: '%2Ffoo%3Dbar',
        empty: '',
      },
    )
    assert.equal(
      value.split(';').filter((pair) => pair.trim().startsWith('vscode-tkn='))
        .length,
      1,
    )
  }
  const pageResponse = await fetch(url, {
    headers: { ...headers, Accept: 'text/html' },
  })
  assert.equal(pageResponse.status, 200)
  const page = load(await pageResponse.text())
  check(
    JSON.parse(
      page('#vscode-workbench-web-configuration').attr('data-settings')!,
    ).cookie,
  )
  const details = await (
    await fetch(new URL('runtime-info', url), { headers })
  ).json()
  check(details.cookie)
  assert.equal(details.authorization, undefined)
  const ws = new WebSocket(
    new URL('cookie-check', url.replace('http:', 'ws:')),
    { headers },
  )
  t.after(() => ws.terminate())
  const [message] = await once(ws, 'message')
  const upgraded = JSON.parse(message.toString())
  check(upgraded.cookie)
  assert.equal(upgraded.authorization, undefined)
  assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 403)
  assert.equal(
    (await fetch(url, { headers: { ...headers, Cookie: 'bad name=value' } }))
      .status,
    403,
  )
  await client.ping()
})

test(
  'real VS Code uses the selected display-language cookie through the proxy',
  {
    skip: !process.env.ADE_TEST_VSCODE_RUNTIME,
    timeout: 30_000,
  },
  async (t) => {
    const { project, config, cleanups, editorRuntime } = await fixture(t)
    editorRuntime.runtimeRoot = process.env.ADE_TEST_VSCODE_RUNTIME!
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const editor = await client.openEditor({ project, path: project })
    for (const locale of ['fr', 'de']) {
      const response = await fetch(editorUrl(server.url, editor), {
        headers: {
          Authorization: `Bearer ${editor.accessToken}`,
          'Accept-Language': 'en',
          Cookie: `vscode-tkn=stale; vscode.nls.locale=${locale}`,
        },
      })
      assert.equal(response.status, 200)
      const page = load(await response.text())
      const scripts = page('script[src]')
        .map((_index, element) => page(element).attr('src'))
        .get()
      assert.ok(
        scripts.some((src) => src.endsWith(`/${locale}/nls.messages.js`)),
        `runtime selects ${locale} despite Accept-Language: en`,
      )
    }
  },
)

test(
  'editors reuse processes across clients, broadcast status and proxy authenticated HTTP and WebSockets',
  { timeout: 30_000 },
  async (t) => {
    const { project, config, cleanups, editorRuntime } = await fixture(t)
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const first = await connect(t, server.url)
    const second = await connect(t, server.url)
    const changes: WorktreeUpdate[] = []
    second.on('worktreesUpdated', (update) => changes.push(update))
    assert.equal((await first.listWorktrees()).worktrees[0].editor, 'stopped')
    const input = { project, path: project }
    const [session, duplicate] = await Promise.all([
      first.openEditor(input),
      second.openEditor(input),
    ])
    assert.deepEqual(session, duplicate)
    assert.equal((await second.listWorktrees()).worktrees[0].editor, 'running')
    assert.ok(
      changes.some(
        (update) =>
          update.change === 'editor' &&
          update.snapshot.worktrees[0].editor === 'starting',
      ),
    )
    assert.ok(
      changes.some(
        (update) => update.snapshot.worktrees[0].editor === 'running',
      ),
    )
    const url = editorUrl(server.url, session)
    assert.equal((await fetch(url)).status, 403)
    assert.equal(
      (await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status,
      403,
    )
    const headers = { Authorization: `Bearer ${session.accessToken}` }
    const page = await fetch(url, {
      headers: { ...headers, Accept: 'text/html' },
    })
    assert.match(await page.text(), /ade-settings-sync\.js/)
    const detailsUrl = new URL('runtime-info', url)
    const running = (await (await fetch(detailsUrl, { headers })).json()) as {
      args: Record<string, string>
      pid: number
    }
    assert.equal(
      running.args['--extensions-dir'],
      config.editor.localExtensionsDir,
    )
    assert.equal(running.args['--default-folder'], project)
    assert.equal(
      running.args['--reconnection-grace-time'],
      String(7 * 24 * 60 * 60),
    )
    const ws = new WebSocket(url.replace('http:', 'ws:'), {
      headers,
      origin: new URL(url).origin,
    })
    t.after(() => ws.terminate())
    await once(ws, 'open')
    const echoed = once(ws, 'message')
    ws.send('terminal data')
    assert.equal((await echoed)[0].toString(), 'terminal data')
    first.stop()
    const restartedApp = await connect(t, server.url)
    assert.deepEqual(await restartedApp.openEditor(input), session)
    assert.equal(
      (await restartedApp.refreshWorktrees()).worktrees[0].editor,
      'running',
    )
    await assert.rejects(
      restartedApp.openEditor({ project, path: join(project, 'unknown') }),
      /unavailable/,
    )
    const after = (await (await fetch(detailsUrl, { headers })).json()) as {
      pid: number
    }
    assert.equal(after.pid, running.pid)
  },
)

test('editor processes do not inherit companion credentials or profile overrides', async (t) => {
  const previous = { ...process.env }
  t.after(() => {
    process.env = previous
  })
  process.env.ADE_COMPANION_TOKEN = 'test-companion-secret'
  process.env.VSCODE_PORTABLE = 'inherited-portable-profile'
  process.env.VSCODE_APPDATA = 'inherited-appdata-profile'
  const { project, config, cleanups, editorRuntime } = await fixture(t)
  const server = await startCompanionServer({ port: 0, config, editorRuntime })
  cleanups.push(() => server.close())
  const client = await connect(t, server.url)
  const editor = await client.openEditor({ project, path: project })
  const response = await fetch(
    new URL('runtime-info', editorUrl(server.url, editor)),
    {
      headers: { Authorization: `Bearer ${editor.accessToken}` },
    },
  )
  const details = await response.json()
  assert.equal(details.companionCredentialPresent, false)
  assert.equal(details.profileOverridePresent, false)
  assert.equal(process.env.ADE_COMPANION_TOKEN, 'test-companion-secret')
  assert.equal(process.env.VSCODE_PORTABLE, 'inherited-portable-profile')
  assert.equal(process.env.VSCODE_APPDATA, 'inherited-appdata-profile')
})

test(
  'real VS Code isolates worktree storage from inherited portable and appdata profiles',
  {
    skip: !process.env.ADE_TEST_VSCODE_RUNTIME,
    timeout: 30_000,
  },
  async (t) => {
    const { root, project, config, cleanups, editorRuntime } = await fixture(t)
    const original = { ...process.env }
    t.after(() => {
      process.env = original
    })
    const portable = join(root, 'inherited portable')
    const appData = join(root, 'inherited appdata')
    await mkdir(join(portable, 'user-data'), { recursive: true })
    await mkdir(appData)
    process.env.VSCODE_PORTABLE = portable
    process.env.VSCODE_APPDATA = appData
    editorRuntime.runtimeRoot = process.env.ADE_TEST_VSCODE_RUNTIME!
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const second = join(root, 'second')
    await completeCreate(client, {
      project,
      path: second,
      baseBranch: 'main',
      branch: 'second',
    })
    for (const path of [project, second]) {
      // Portable overrides appdata; check appdata independently for the second child.
      if (path === second) delete process.env.VSCODE_PORTABLE
      const editor = await client.openEditor({ project, path })
      const data = join(config.editor.dataDir, 'workspaces', editor.id, 'data')
      const entries = await readdir(data)
      assert.ok(
        entries.includes('logs'),
        'runtime logs belong to this worktree',
      )
      assert.ok((await readdir(join(data, 'logs'))).length > 0)
    }
    assert.deepEqual(await readdir(join(portable, 'user-data')), [])
    assert.deepEqual(await readdir(appData), [])
  },
)

test(
  'proxy socket errors close only the affected connection and preserve editor sessions',
  { timeout: 15_000 },
  async (t) => {
    let downstream: Socket | undefined
    const emit = Server.prototype.emit
    t.mock.method(
      Server.prototype,
      'emit',
      function (this: Server, event: string, ...args: unknown[]) {
        if (
          event === 'upgrade' &&
          (args[0] as IncomingMessage).url?.endsWith('/fault')
        )
          downstream = args[1] as Socket
        return emit.call(this, event, ...args)
      },
    )
    const { project, config, cleanups, editorRuntime } = await fixture(t)
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const input = { project, path: project }
    const editor = await client.openEditor(input)
    const url = editorUrl(server.url, editor).replace('http:', 'ws:')
    const headers = { Authorization: `Bearer ${editor.accessToken}` }
    const healthy = new WebSocket(url, { headers })
    t.after(() => healthy.terminate())
    await once(healthy, 'open')
    for (const code of ['ECONNRESET', 'ECONNABORTED']) {
      const failing = new WebSocket(new URL('fault', url), { headers })
      t.after(() => failing.terminate())
      await once(failing, 'open')
      assert.ok(downstream)
      const closed = once(failing, 'close')
      // Inject an OS error on the real accepted socket so the proxy's direct
      // error event is exercised deterministically on every platform.
      assert.doesNotThrow(() =>
        downstream!.emit(
          'error',
          Object.assign(new Error('test socket reset'), { code }),
        ),
      )
      await closed
      assert.ok(downstream.destroyed)
      const reply = once(healthy, 'message')
      healthy.send(code)
      assert.equal((await reply)[0].toString(), code)
      assert.equal(
        (await client.listWorktrees()).worktrees[0].editor,
        'running',
      )
      assert.deepEqual(await client.openEditor(input), editor)
    }
  },
)

test(
  'worktrees have distinct saved state, shared extensions, crash recovery and safe deletion',
  { timeout: 30_000 },
  async (t) => {
    const { project, config, root, cleanups, editorRuntime } = await fixture(t)
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const linked = join(root, 'second ü worktree')
    await completeCreate(client, {
      project,
      path: linked,
      baseBranch: 'main',
      branch: 'feature',
    })
    const main = await client.openEditor({ project, path: project })
    const other = await client.openEditor({ project, path: linked })
    const details = async (session: EditorSession) =>
      (await (
        await fetch(new URL('runtime-info', editorUrl(server.url, session)), {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        })
      ).json()) as { args: Record<string, string> }
    const mainDetails = await details(main)
    const otherDetails = await details(other)
    assert.equal(
      mainDetails.args['--extensions-dir'],
      otherDetails.args['--extensions-dir'],
    )
    assert.notEqual(
      mainDetails.args['--user-data-dir'],
      otherDetails.args['--user-data-dir'],
    )
    const settings = join(
      mainDetails.args['--user-data-dir'],
      'User',
      'settings.json',
    )
    await writeFile(settings, '{"custom": true}')
    const stopped = new Promise<void>((resolve) =>
      client.on('worktreesUpdated', (update) => {
        if (
          update.snapshot.worktrees.find((entry) => entry.path === project)
            ?.editor === 'stopped'
        )
          resolve()
      }),
    )
    await fetch(new URL('crash', editorUrl(server.url, main)), {
      headers: { Authorization: `Bearer ${main.accessToken}` },
    })
    await stopped
    const reopened = await client.openEditor({ project, path: project })
    assert.equal(reopened.id, main.id)
    assert.notEqual(reopened.accessToken, main.accessToken)
    assert.equal(await readFile(settings, 'utf8'), '{"custom": true}')
    await completeDelete(client, { project, path: linked })
    assert.equal(
      (
        await fetch(editorUrl(server.url, other), {
          headers: { Authorization: `Bearer ${other.accessToken}` },
        })
      ).status,
      403,
    )
    assert.equal((await client.listWorktrees()).worktrees.length, 1)
  },
)

for (const operation of ['create', 'failed-create', 'refresh'] as const) {
  test(
    `${operation} reconciles removed editors and preserves editors in other projects`,
    { timeout: 20_000 },
    async (t) => {
      const { project, config, root, cleanups, editorRuntime } =
        await fixture(t)
      const otherProject = join(root, 'other project')
      await execute('git', ['clone', '--no-hardlinks', project, otherProject])
      const server = await startCompanionServer({
        port: 0,
        config: {
          ...config,
          projects: [
            { mainWorktreePath: project },
            { mainWorktreePath: otherProject },
          ],
        },
        editorRuntime,
      })
      cleanups.push(() => server.close())
      const client = await connect(t, server.url)
      const removed = join(root, 'removed externally')
      await completeCreate(client, {
        project,
        path: removed,
        branch: 'removed',
        baseBranch: 'main',
      })
      const running = await client.openEditor({ project, path: removed })
      const survivor = await client.openEditor({
        project: otherProject,
        path: otherProject,
      })
      const info = async (editor: EditorSession) =>
        (await (
          await fetch(new URL('runtime-info', editorUrl(server.url, editor)), {
            headers: { Authorization: `Bearer ${editor.accessToken}` },
          })
        ).json()) as { pid: number }
      const stoppedPid = (await info(running)).pid
      const survivorPid = (await info(survivor)).pid
      // Windows holds a process's working directory open. Let the fake runtime
      // release that handle while it remains alive, then remove through Git.
      await fetch(new URL('release-cwd', editorUrl(server.url, running)), {
        headers: { Authorization: `Bearer ${running.accessToken}` },
      })
      await execute('git', ['-C', project, 'worktree', 'remove', '--', removed])
      // External Git changes have not yet been accepted into the cached list.
      assert.ok(
        (await client.listWorktrees()).worktrees.some(
          (tree) => tree.path === removed,
        ),
      )
      assert.equal((await info(running)).pid, stoppedPid)
      if (operation === 'refresh') await client.refreshWorktrees()
      else {
        if (operation === 'failed-create') {
          const hooks = join(root, 'hooks')
          await mkdir(hooks)
          await writeFile(
            join(hooks, 'post-checkout'),
            '#!/bin/sh\necho checkout-hook-failed >&2\nexit 1\n',
            { mode: 0o755 },
          )
          await execute('git', [
            '-C',
            project,
            'config',
            'core.hooksPath',
            hooks,
          ])
        }
        const create = completeCreate(client, {
          project,
          path: join(root, 'created'),
          branch: 'created',
          baseBranch: 'main',
        })
        if (operation === 'failed-create')
          await assert.rejects(create, /checkout-hook-failed/)
        else await create
      }
      assert.ok(
        !(await client.listWorktrees()).worktrees.some(
          (tree) => tree.path === removed,
        ),
      )
      assert.throws(() => process.kill(stoppedPid, 0), { code: 'ESRCH' })
      assert.equal(
        (
          await fetch(editorUrl(server.url, running), {
            headers: { Authorization: `Bearer ${running.accessToken}` },
          })
        ).status,
        403,
      )
      assert.equal((await info(survivor)).pid, survivorPid)
      assert.deepEqual(
        await client.openEditor({ project: otherProject, path: otherProject }),
        survivor,
      )
    },
  )
}

test(
  'project reconciliation cancels a removed editor still preparing its runtime',
  { timeout: 15_000 },
  async (t) => {
    const { project, config, root, cleanups, editorRuntime } = await fixture(t)
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const get = editorRuntime.get.bind(editorRuntime)
    t.mock.method(editorRuntime, 'get', async () => {
      await waiting
      return get()
    })
    t.after(release)
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const removed = join(root, 'removed while starting')
    await completeCreate(client, {
      project,
      path: removed,
      branch: 'removed',
      baseBranch: 'main',
    })
    const starting = once(client, 'worktreesUpdated')
    const cancelled = assert.rejects(
      client.openEditor({ project, path: removed }),
      /cancelled|aborted/,
    )
    await starting
    await execute('git', ['-C', project, 'worktree', 'remove', '--', removed])
    const result = await completeCreate(client, {
      project,
      path: join(root, 'replacement'),
      branch: 'replacement',
      baseBranch: 'main',
    })
    await cancelled
    assert.ok(!result.worktrees.some((tree) => tree.path === removed))
    release()
    await client.ping()
  },
)

test('new editor processes use an updated runtime without replacing existing sessions', async (t) => {
  const { project, config, cleanups, root, editorRuntime } = await fixture(t)
  const server = await startCompanionServer({
    port: 0,
    config: {
      ...config,
      editor: { ...config.editor, reconnectionGraceSeconds: 600 },
    },
    editorRuntime,
  })
  cleanups.push(() => server.close())
  const client = await connect(t, server.url)
  const first = await client.openEditor({ project, path: project })
  const details = async (session: EditorSession) =>
    (await (
      await fetch(new URL('runtime-info', editorUrl(server.url, session)), {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      })
    ).json()) as { args: Record<string, string>; pid: number; runtime: string }
  const before = await details(first)
  const nextRoot = join(root, 'updated runtime')
  await cp(editorRuntime.runtimeRoot, nextRoot, { recursive: true })
  editorRuntime.runtimeRoot = nextRoot
  const nextPath = join(root, 'new worktree')
  await completeCreate(client, {
    project,
    path: nextPath,
    branch: 'next',
    baseBranch: 'main',
  })
  const second = await client.openEditor({ project, path: nextPath })
  assert.notEqual((await details(second)).pid, before.pid)
  assert.equal(
    (await details(second)).runtime,
    join(nextRoot, 'out', 'server-main.js'),
  )
  assert.equal((await details(second)).args['--reconnection-grace-time'], '600')
  assert.deepEqual(await client.openEditor({ project, path: project }), first)
  assert.equal((await details(first)).pid, before.pid)
  const settings = join(before.args['--user-data-dir'], 'User', 'settings.json')
  await writeFile(settings, '{"editor.fontSize":31}')
  await server.close()
  const restartedRuntime = new FixtureRuntime(root, nextRoot)
  const restarted = await startCompanionServer({
    port: 0,
    config,
    editorRuntime: restartedRuntime,
  })
  cleanups.push(() => restarted.close())
  const restartedClient = await connect(t, restarted.url)
  const reopened = await restartedClient.openEditor({ project, path: project })
  assert.equal(reopened.id, first.id)
  assert.equal(await readFile(settings, 'utf8'), '{"editor.fontSize":31}')
})

test(
  'startup errors survive reconnects and successful opens until explicitly cleared',
  { timeout: 15_000 },
  async (t) => {
    const { project, config, cleanups, editorRuntime } = await fixture(t)
    const workingRuntime = editorRuntime.runtimeRoot
    editorRuntime.runtimeRoot = join(editorRuntime.runtimeRoot, 'missing')
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    await assert.rejects(
      client.openEditor({ project, path: project }),
      /ENOENT/,
    )
    assert.equal((await client.listWorktrees()).worktrees[0].editor, 'stopped')
    assert.match((await client.listWorktrees()).worktrees[0].error!, /ENOENT/)
    const reconnected = await connect(t, server.url)
    assert.match(
      (await reconnected.listWorktrees()).worktrees[0].error!,
      /ENOENT/,
    )
    editorRuntime.runtimeRoot = workingRuntime
    const failure = (await reconnected.listWorktrees()).worktrees[0].error
    const updates: WorktreeUpdate[] = []
    reconnected.on('worktreesUpdated', (update) => updates.push(update))
    const opening = reconnected.openEditor({ project, path: project })
    assert.equal(
      (await reconnected.listWorktrees()).worktrees[0].error,
      failure,
    )
    const session = await opening
    assert.deepEqual(
      await reconnected.openEditor({ project, path: project }),
      session,
    )
    assert.ok(
      updates.some(
        (update) => update.snapshot.worktrees[0].editor === 'starting',
      ),
    )
    for (const update of updates)
      assert.equal(update.snapshot.worktrees[0].error, failure)
    const reopened = (await client.listWorktrees()).worktrees[0]
    assert.equal(reopened.editor, 'running')
    assert.equal(reopened.error, failure)
    await reconnected.setWorktreeError({ project, path: project })
    assert.equal((await client.listWorktrees()).worktrees[0].error, undefined)
    await client.ping()
  },
)

test(
  'slow editor startup does not block refresh, and deleting the worktree cancels startup',
  { timeout: 15_000 },
  async (t) => {
    const { project, root, config, cleanups, editorRuntime } = await fixture(
      t,
      10_000,
    )
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const path = join(root, 'slow')
    await completeCreate(client, {
      project,
      path,
      branch: 'slow',
      baseBranch: 'main',
    })
    const starting = once(client, 'worktreesUpdated')
    const cancelled = assert.rejects(
      client.openEditor({ project, path }),
      /cancelled|aborted/,
    )
    await starting
    const refreshed = await client.refreshWorktrees()
    assert.equal(
      refreshed.worktrees.find((worktree) => worktree.path === path)?.editor,
      'starting',
    )
    assert.ok(
      refreshed.worktrees.find((worktree) => worktree.path === path)
        ?.editorDetail,
    )
    await completeDelete(client, { project, path })
    await cancelled
    assert.equal((await client.listWorktrees()).worktrees.length, 1)
  },
)

test('server and editor logs identify startup stages without exposing session tokens', async (t) => {
  const { project, config, cleanups, editorRuntime } = await fixture(t)
  let log = ''
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      log += chunk.toString()
      callback()
    },
  })
  const logger = pino({ level: 'debug' }, sink)
  const server = await startCompanionServer({
    port: 0,
    config,
    logger,
    editorRuntime,
  })
  cleanups.push(() => server.close())
  const client = await connect(t, server.url)
  const session = await client.openEditor({ project, path: project })
  await server.close()
  sink.end()
  const messages = log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.ok(
    messages.some(
      (entry) =>
        entry.command === 'editor:open' &&
        entry.requestId &&
        entry.msg === 'Command received',
    ),
  )
  assert.ok(messages.some((entry) => entry.msg === 'Launching VS Code'))
  assert.ok(messages.some((entry) => entry.msg === 'VS Code exited'))
  assert.ok(
    messages.some(
      (entry) =>
        entry.msg === 'Editor ready' && typeof entry.elapsedMs === 'number',
    ),
  )
  assert.ok(!log.includes(session.accessToken))
  const editorLog = await readFile(
    join(config.editor.dataDir, 'workspaces', session.id, 'server.log'),
    'utf8',
  )
  assert.match(editorLog, /stdout token sample: \[redacted\]/)
  assert.match(editorLog, /stderr token sample: \[redacted\]/)
  assert.ok(!editorLog.includes(session.accessToken))
})

const idleMs = Number(process.env.ADE_TEST_EDITOR_IDLE_MS ?? 0)

test(
  'real VS Code keeps extension credentials out of native terminals/tasks and renews document activation on reload',
  { skip: !process.env.ADE_TEST_VSCODE_RUNTIME, timeout: 90_000 },
  async (t) => {
    const {
      root,
      project,
      config: baseConfig,
      cleanups,
      editorRuntime,
    } = await fixture(t)
    const local = await localVSCodeFixture(root)
    const extension = join(local.localExtensionsDir, 'ade.bootstrap-test-1.0.0')
    await mkdir(extension)
    await writeFile(
      join(extension, 'package.json'),
      JSON.stringify({
        name: 'bootstrap-test',
        publisher: 'ade',
        version: '1.0.0',
        engines: { vscode: '^1.96.0' },
        main: './index.cjs',
        extensionKind: ['workspace'],
        activationEvents: ['onStartupFinished'],
      }),
    )
    await copyFile(
      fileURLToPath(
        new URL('./fixtures/bootstrap-extension.cjs', import.meta.url),
      ),
      join(extension, 'index.cjs'),
    )
    await writeFile(
      join(extension, 'bootstrap-config.json'),
      JSON.stringify({ ws: fileURLToPath(import.meta.resolve('ws')) }),
    )
    const extensionsFile = join(local.localExtensionsDir, 'extensions.json')
    const installed = JSON.parse(await readFile(extensionsFile, 'utf8'))
    installed.push({
      identifier: { id: 'ade.bootstrap-test' },
      version: '1.0.0',
      relativeLocation: 'ade.bootstrap-test-1.0.0',
      location: {
        scheme: 'file',
        path: decodeURIComponent(pathToFileURL(extension).pathname),
      },
      metadata: { installedTimestamp: 1 },
    })
    await writeFile(extensionsFile, JSON.stringify(installed))
    editorRuntime.runtimeRoot = process.env.ADE_TEST_VSCODE_RUNTIME!
    const server = await startCompanionServer({
      port: 0,
      config: { ...baseConfig, editor: { ...baseConfig.editor, ...local } },
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const editor = await client.openEditor({ project, path: project })
    const result = join(root, 'bootstrap-result.json')
    const input = join(root, 'bootstrap-input.json')
    await writeFile(
      input,
      JSON.stringify({
        project,
        editor,
        url: server.url,
        result,
        userData: join(root, 'browser'),
        editorModule: await bundleMain(root, 'editor-window'),
      }),
    )
    let failure
    try {
      await execute(
        electron as unknown as string,
        [
          fileURLToPath(
            new URL('./fixtures/editor-bootstrap.mjs', import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: undefined,
            ADE_EDITOR_TEST_INPUT: input,
          },
          windowsHide: true,
          timeout: 65_000,
        },
      )
    } catch (error) {
      failure = error
    }
    const outcome = JSON.parse(await readFile(result, 'utf8'))
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    if (failure) throw failure
  },
)

test(
  'real VS Code periodically syncs whole User settings files and reconnects after offline saves',
  { skip: !process.env.ADE_TEST_VSCODE_RUNTIME, timeout: 160_000 },
  async (t) => {
    const {
      project,
      config: baseConfig,
      cleanups,
      root,
      editorRuntime,
    } = await fixture(t)
    const local = await localVSCodeFixture(root, true)
    const config = { ...baseConfig, editor: { ...baseConfig.editor, ...local } }
    editorRuntime.runtimeRoot = process.env.ADE_TEST_VSCODE_RUNTIME!
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const second = join(root, 'second')
    await completeCreate(client, {
      project,
      path: second,
      baseBranch: 'main',
      branch: 'second',
    })
    const sessions = []
    for (const path of [project, second])
      sessions.push(await client.openEditor({ project, path }))
    const results = []
    const syncModule = await bundleMain(root, 'settings-sync')
    for (const phase of ['initial', 'restart']) {
      const inputPath = join(root, `sync-${phase}.json`)
      const result = join(root, `sync-${phase}-result.json`)
      await writeFile(
        inputPath,
        JSON.stringify({
          project,
          second,
          sessions,
          phase,
          result,
          url: server.url,
          localSettings: join(local.localUserDataDir, 'User', 'settings.json'),
          userData: join(root, 'sync-browser'),
          syncModule,
          offlineText:
            '{ /* Saved offline */ "editor.fontSize":27, "files.hotExit":"off" }',
        }),
      )
      let failure
      try {
        await execute(
          electron as unknown as string,
          [
            fileURLToPath(
              new URL('./fixtures/settings-sync-window.mjs', import.meta.url),
            ),
          ],
          {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: undefined,
              ADE_EDITOR_TEST_INPUT: inputPath,
            },
            windowsHide: true,
            timeout: 75_000,
          },
        )
      } catch (error) {
        failure = error
      }
      const outcome = JSON.parse(await readFile(result, 'utf8'))
      results.push(outcome)
      await writeFile(
        resolve('out/settings-sync-test-result.json'),
        JSON.stringify(results, null, 2),
      )
      assert.equal(outcome.ok, true, JSON.stringify(outcome))
      if (failure) throw failure
    }
  },
)

test(
  'real VS Code imports local settings and Node extensions, switches worktrees and restores state after an app restart',
  { skip: !process.env.ADE_TEST_VSCODE_RUNTIME, timeout: 150_000 + idleMs },
  async (t) => {
    const {
      project,
      config: baseConfig,
      cleanups,
      root,
      editorRuntime,
    } = await fixture(t)
    const config = {
      ...baseConfig,
      editor: {
        ...baseConfig.editor,
        ...(await localVSCodeFixture(root)),
      },
    }
    // Patch only this test's private copy, never the developer's live runtime.
    const runtime = join(root, 'mouse-runtime')
    await cp(process.env.ADE_TEST_VSCODE_RUNTIME!, runtime, { recursive: true })
    await prepareTerminalSerialization(runtime)
    await validateTerminalSerialization(runtime)
    editorRuntime.runtimeRoot = runtime
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const second = join(root, 'second')
    await completeCreate(client, {
      project,
      path: second,
      baseBranch: 'main',
      branch: 'feature',
    })
    await writeFile(
      join(project, 'persist.txt'),
      'An editor persistence test.\n',
    )
    await copyFile(
      fileURLToPath(new URL('./fixtures/terminal-mouse.cjs', import.meta.url)),
      join(project, 'terminal-mouse.cjs'),
    )
    for (const phase of ['first', 'second']) {
      const inputPath = join(root, `${phase}.json`)
      const result = join(root, `${phase}-result.json`)
      await writeFile(
        inputPath,
        JSON.stringify({
          project,
          second,
          phase,
          result,
          screenshot: resolve('out/editor-smoke.png'),
          userData: join(root, 'desktop-data'),
          main: resolve('out/main/index.js'),
          node: process.execPath,
        }),
      )
      let failure: unknown
      try {
        await execute(
          electron as unknown as string,
          [
            fileURLToPath(
              new URL('./fixtures/editor-window.mjs', import.meta.url),
            ),
          ],
          {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: undefined,
              ADE_COMPANION_URL: server.url,
              ADE_COMPANION_TOKEN: '',
              ADE_EDITOR_TEST_INPUT: inputPath,
            },
            windowsHide: true,
            timeout: 55_000,
          },
        )
      } catch (error) {
        failure = error
      }
      const outcome = JSON.parse(await readFile(result, 'utf8'))
      if (!outcome.ok) {
        await cp(config.editor.dataDir, resolve('out/editor-test-logs'), {
          recursive: true,
        })
        await copyFile(result, resolve('out/editor-test-result.json'))
      }
      assert.equal(outcome.ok, true, JSON.stringify(outcome))
      if (failure) throw failure
      if (phase === 'first' && idleMs > 0) {
        client.stop()
        const started = Date.now()
        console.log(
          'Editor soak: desktop exited; no editor requests during the idle period.',
        )
        while (Date.now() - started < idleMs) {
          await delay(Math.min(60_000, idleMs - (Date.now() - started)))
          console.log(
            `Editor soak: disconnected for ${Math.round((Date.now() - started) / 60_000)} minutes`,
          )
        }
      }
    }
    // The effective Remote override must not flow back through User settings sync.
    const local = parse(
      await readFile(
        join(config.editor.localUserDataDir, 'User', 'settings.json'),
        'utf8',
      ),
    )
    assert.equal(local['terminal.integrated.enablePersistentSessions'], false)
    assert.equal(local['editor.fontSize'], 29)
  },
)
