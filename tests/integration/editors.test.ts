import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  completeCreate,
  completeDelete,
} from '../helpers/worktree-operations.ts'
import assert from 'node:assert/strict'
import { Server, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import pino from 'pino'
import { load } from 'cheerio'
import { parseCookie } from 'cookie'
import { Writable } from 'node:stream'
import { WebSocket } from 'ws'
import { startCompanionServer } from '../../src/server/server.ts'
import { FixtureRuntime } from '../fixtures/editor-runtime.ts'
import { localVSCodeFixture } from '../helpers/local-vscode.ts'
import { loadServerConfig } from '../../src/server/config.ts'
import {
  MAX_SETTINGS_BYTES,
  SettingsSnapshot,
} from '../../src/shared/editor-settings.ts'
import {
  companionRequests,
  type EditorServerSession,
  type WorktreeSnapshot,
} from '../../src/shared/companion.ts'
import { fixture, connect, editorUrl } from '../helpers/editor-server.ts'

const execute = promisify(execFile)

test('editor commands validate inputs and sessions', () => {
  assert.equal(
    companionRequests.companionStartEditorServer.input.safeParse({
      project: 'repo',
      path: '\0',
    }).success,
    false,
  )
  assert.equal(
    companionRequests.companionStartEditorServer.output.safeParse({
      id: 'x',
      accessToken: 'bad',
    }).success,
    false,
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

test('project chat commands reach all its editors and reset after companion configuration changes', async (t) => {
  const { project, config, root, cleanups, editorRuntime } = await fixture(t)
  const second = await fixture(t)
  const linked = join(root, 'linked')
  await execute('git', [
    '-C',
    project,
    'worktree',
    'add',
    '-b',
    'linked',
    linked,
  ])
  const configPath = join(root, 'server.yaml')
  const commands = {
    codex: "custom-codex --no-daemon --profile 'my project'",
    claude: 'custom-claude',
  }
  for (const chatCommands of [commands, undefined]) {
    // JSON is valid YAML and preserves command quoting verbatim.
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        projects: [
          { mainWorktreePath: project, chatCommands },
          {
            mainWorktreePath: second.project,
            chatCommands: { claude: 'second-claude' },
          },
        ],
      }),
    )
    const server = await startCompanionServer({
      port: 0,
      configPath,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    for (const [owner, path, expected] of [
      [project, project, chatCommands ?? {}],
      [project, linked, chatCommands ?? {}],
      [second.project, second.project, { claude: 'second-claude' }],
    ] as const) {
      const session = await client.companionStartEditorServer({
        project: owner,
        path,
      })
      const response = await fetch(
        new URL('runtime-info', editorUrl(server.url, session)),
        {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        },
      )
      assert.deepEqual((await response.json()).chatCommands, expected)
    }
    client.stop()
    await server.close()
  }
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
  const session = await client.companionStartEditorServer({
    project,
    path: project,
  })
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
  const limit = MAX_SETTINGS_BYTES * 6 + 1024
  const body = JSON.stringify(new SettingsSnapshot('{}\n', 0))
  for (const extra of [0, 1]) {
    const response = await fetch(syncUrl, {
      method: 'POST',
      headers,
      body: body.padEnd(limit + extra, ' '),
    })
    assert.equal(response.status, extra ? 413 : 200)
    await response.text()
  }
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
  const editor = await client.companionStartEditorServer({
    project,
    path: project,
  })
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
  await client.companionListWorktrees()
})

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
    const changes: WorktreeSnapshot[] = []
    second.on('desktopUpdateWorktrees', (update) => changes.push(update))
    assert.equal(
      (await first.companionListWorktrees()).worktrees[0].editorServer,
      'stopped',
    )
    const input = { project, path: project }
    const [session, duplicate] = await Promise.all([
      first.companionStartEditorServer(input),
      second.companionStartEditorServer(input),
    ])
    assert.deepEqual(session, duplicate)
    assert.equal(
      (await second.companionListWorktrees()).worktrees[0].editorServer,
      'running',
    )
    assert.ok(
      changes.some((update) => update.worktrees[0].editorServer === 'starting'),
    )
    assert.ok(
      changes.some((update) => update.worktrees[0].editorServer === 'running'),
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
    assert.deepEqual(
      await restartedApp.companionStartEditorServer(input),
      session,
    )
    assert.equal(
      (await restartedApp.companionRefreshWorktrees()).worktrees[0]
        .editorServer,
      'running',
    )
    await assert.rejects(
      restartedApp.companionStartEditorServer({
        project,
        path: join(project, 'unknown'),
      }),
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
  const editor = await client.companionStartEditorServer({
    project,
    path: project,
  })
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
    const editor = await client.companionStartEditorServer(input)
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
        (await client.companionListWorktrees()).worktrees[0].editorServer,
        'running',
      )
      assert.deepEqual(await client.companionStartEditorServer(input), editor)
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
    const main = await client.companionStartEditorServer({
      project,
      path: project,
    })
    const other = await client.companionStartEditorServer({
      project,
      path: linked,
    })
    const details = async (session: EditorServerSession) =>
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
    await mkdir(dirname(settings), { recursive: true })
    await writeFile(settings, '{"custom": true}')
    const stopped = new Promise<void>((resolve) =>
      client.on('desktopUpdateWorktrees', (update) => {
        if (
          update.worktrees.find((entry) => entry.path === project)
            ?.editorServer === 'stopped'
        )
          resolve()
      }),
    )
    await fetch(new URL('crash', editorUrl(server.url, main)), {
      headers: { Authorization: `Bearer ${main.accessToken}` },
    })
    await stopped
    const reopened = await client.companionStartEditorServer({
      project,
      path: project,
    })
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
    assert.equal((await client.companionListWorktrees()).worktrees.length, 1)
  },
)

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
    const starting = once(client, 'desktopUpdateWorktrees')
    const cancelled = assert.rejects(
      client.companionStartEditorServer({ project, path: removed }),
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
    await client.companionListWorktrees()
  },
)

test('editors share one runtime and retain workspace data when the companion restarts with a new build', async (t) => {
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
  const first = await client.companionStartEditorServer({
    project,
    path: project,
  })
  const details = async (session: EditorServerSession) =>
    (await (
      await fetch(new URL('runtime-info', editorUrl(server.url, session)), {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      })
    ).json()) as { args: Record<string, string>; pid: number; runtime: string }
  const before = await details(first)
  const nextRoot = join(root, 'updated runtime')
  await cp(editorRuntime.runtimeRoot, nextRoot, { recursive: true })
  const nextPath = join(root, 'new worktree')
  await completeCreate(client, {
    project,
    path: nextPath,
    branch: 'next',
    baseBranch: 'main',
  })
  const second = await client.companionStartEditorServer({
    project,
    path: nextPath,
  })
  assert.notEqual((await details(second)).pid, before.pid)
  assert.equal(
    (await details(second)).runtime,
    join(editorRuntime.runtimeRoot, 'out', 'server-main.js'),
  )
  assert.equal((await details(second)).args['--reconnection-grace-time'], '600')
  assert.deepEqual(
    await client.companionStartEditorServer({ project, path: project }),
    first,
  )
  assert.equal((await details(first)).pid, before.pid)
  const settings = join(before.args['--user-data-dir'], 'User', 'settings.json')
  await mkdir(dirname(settings), { recursive: true })
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
  const reopened = await restartedClient.companionStartEditorServer({
    project,
    path: project,
  })
  assert.equal(reopened.id, first.id)
  const after = (await (
    await fetch(new URL('runtime-info', editorUrl(restarted.url, reopened)), {
      headers: { Authorization: `Bearer ${reopened.accessToken}` },
    })
  ).json()) as { runtime: string }
  assert.equal(after.runtime, join(nextRoot, 'out', 'server-main.js'))
  assert.equal(await readFile(settings, 'utf8'), '{"editor.fontSize":31}')
})

test(
  'stopping is published before the process exits and refuses opens until stopped',
  { timeout: 30_000 },
  async (t) => {
    const { project, config, cleanups, editorRuntime } = await fixture(t)
    const server = await startCompanionServer({
      port: 0,
      config,
      editorRuntime,
    })
    cleanups.push(() => server.close())
    const client = await connect(t, server.url)
    const input = { project, path: project }
    const session = await client.companionStartEditorServer(input)
    const states: string[] = []
    client.on('desktopUpdateWorktrees', (update) =>
      states.push(update.worktrees[0].editorServer),
    )
    const stopped = client.companionStopEditorServer(input)
    await assert.rejects(
      client.companionStartEditorServer(input),
      /still stopping/,
    )
    const row = (await stopped).worktrees[0]
    assert.equal(row.editorServer, 'stopped')
    assert.equal(row.error, undefined)
    assert.ok(states.indexOf('stopping') >= 0)
    assert.ok(states.indexOf('stopping') < states.lastIndexOf('stopped'))
    const reopened = await client.companionStartEditorServer(input)
    assert.notEqual(reopened.accessToken, session.accessToken)
  },
)

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
      client.companionStartEditorServer({ project, path: project }),
      /ENOENT/,
    )
    assert.equal(
      (await client.companionListWorktrees()).worktrees[0].editorServer,
      'stopped',
    )
    assert.match(
      (await client.companionListWorktrees()).worktrees[0].error!,
      /ENOENT/,
    )
    const reconnected = await connect(t, server.url)
    assert.match(
      (await reconnected.companionListWorktrees()).worktrees[0].error!,
      /ENOENT/,
    )
    editorRuntime.runtimeRoot = workingRuntime
    const failure = (await reconnected.companionListWorktrees()).worktrees[0]
      .error
    const updates: WorktreeSnapshot[] = []
    reconnected.on('desktopUpdateWorktrees', (update) => updates.push(update))
    const opening = reconnected.companionStartEditorServer({
      project,
      path: project,
    })
    assert.equal(
      (await reconnected.companionListWorktrees()).worktrees[0].error,
      failure,
    )
    const session = await opening
    assert.deepEqual(
      await reconnected.companionStartEditorServer({ project, path: project }),
      session,
    )
    assert.ok(
      updates.some((update) => update.worktrees[0].editorServer === 'starting'),
    )
    for (const update of updates)
      assert.equal(update.worktrees[0].error, failure)
    const reopened = (await client.companionListWorktrees()).worktrees[0]
    assert.equal(reopened.editorServer, 'running')
    assert.equal(reopened.error, failure)
    await reconnected.companionSetWorktreeError({ project, path: project })
    assert.equal(
      (await client.companionListWorktrees()).worktrees[0].error,
      undefined,
    )
    await client.companionListWorktrees()
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
    const starting = once(client, 'desktopUpdateWorktrees')
    const cancelled = assert.rejects(
      client.companionStartEditorServer({ project, path }),
      /cancelled|aborted/,
    )
    await starting
    const refreshed = await client.companionRefreshWorktrees()
    assert.equal(
      refreshed.worktrees.find((worktree) => worktree.path === path)
        ?.editorServer,
      'starting',
    )
    assert.ok(
      refreshed.worktrees.find((worktree) => worktree.path === path)
        ?.editorServerDetail,
    )
    await completeDelete(client, { project, path })
    await cancelled
    assert.equal((await client.companionListWorktrees()).worktrees.length, 1)
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
  const session = await client.companionStartEditorServer({
    project,
    path: project,
  })
  const invalid = await fetch(
    new URL('ade-settings-sync', editorUrl(server.url, session)),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}` },
      body: '{"credential":"private-settings-marker" trailing-invalid-json',
    },
  )
  assert.equal(invalid.status, 400)
  assert.ok(!(await invalid.text()).includes('private-settings-marker'))
  assert.match(log, /Invalid settings sync JSON/)
  assert.ok(!log.includes('private-settings-marker'))
  await server.close()
  sink.end()
  const messages = log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.ok(
    messages.some(
      (entry) =>
        entry.command === 'companionStartEditorServer' &&
        entry.clientId &&
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
      const running = await client.companionStartEditorServer({
        project,
        path: removed,
      })
      const survivor = await client.companionStartEditorServer({
        project: otherProject,
        path: otherProject,
      })
      const info = async (editor: EditorServerSession) =>
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
        (await client.companionListWorktrees()).worktrees.some(
          (tree) => tree.path === removed,
        ),
      )
      assert.equal((await info(running)).pid, stoppedPid)
      if (operation === 'refresh') await client.companionRefreshWorktrees()
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
        !(await client.companionListWorktrees()).worktrees.some(
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
        await client.companionStartEditorServer({
          project: otherProject,
          path: otherProject,
        }),
        survivor,
      )
    },
  )
}
