import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { completeCreate } from '../helpers/worktree-operations.ts'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'
import { build } from 'vite'
import { builtinModules } from 'node:module'
import { load } from 'cheerio'
import { parse } from 'jsonc-parser'
import { validateTerminalSerialization } from '../../src/server/editors/terminal-serialization.ts'
import { startCompanionServer } from '../../src/server/server.ts'
import { localVSCodeFixture } from '../helpers/local-vscode.ts'
import { bundleMain } from '../helpers/bundle-main.ts'
import { fixture, connect, editorUrl } from '../helpers/editor-server.ts'

const idleMs = Number(process.env.ADE_TEST_EDITOR_IDLE_MS ?? 0)

const execute = promisify(execFile)

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
    const editor = await client.companionStartEditorServer({
      project,
      path: project,
    })
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
      const editor = await client.companionStartEditorServer({ project, path })
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
  'real VS Code keeps extension credentials out of native terminals/tasks and restores chat terminal identities on reload',
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
      fileURLToPath(new URL('./bootstrap-extension.cjs', import.meta.url)),
      join(extension, 'index.cjs'),
    )
    await build({
      configFile: false,
      logLevel: 'silent',
      resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
      build: {
        target: 'node22',
        outDir: extension,
        emptyOutDir: false,
        lib: {
          entry: Object.fromEntries(
            ['chats', 'terminal-identities'].map((name) => [
              name,
              fileURLToPath(
                new URL(
                  `../../extensions/ade-terminals/src/${name}.ts`,
                  import.meta.url,
                ),
              ),
            ]),
          ),
          formats: ['cjs'],
          fileName: (_format, name) => `${name}.cjs`,
        },
        rollupOptions: {
          external: [
            'vscode',
            /^node:/,
            ...builtinModules,
            'bufferutil',
            'utf-8-validate',
          ],
        },
      },
    })
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
    const editor = await client.companionStartEditorServer({
      project,
      path: project,
    })
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
        [fileURLToPath(new URL('./editor-bootstrap.mjs', import.meta.url))],
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
      sessions.push(await client.companionStartEditorServer({ project, path }))
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
              new URL('./settings-sync-window.mjs', import.meta.url),
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

for (const { name, phases } of [
  {
    name: 'real VS Code imports local settings and Node extensions, switches worktrees and restores state after an app restart',
    phases: ['first', 'second'],
  },
  {
    name: 'real VS Code preserves rich chat paste order and normal terminal input',
    phases: ['paste'],
  },
])
  test(
    name,
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
      // The compatibility command prepares the exact immutable runtime used by ADE.
      editorRuntime.runtimeRoot = process.env.ADE_TEST_VSCODE_RUNTIME!
      await validateTerminalSerialization(editorRuntime.runtimeRoot)
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
        fileURLToPath(
          new URL('../fixtures/terminal-mouse.cjs', import.meta.url),
        ),
        join(project, 'terminal-mouse.cjs'),
      )
      for (const phase of phases) {
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
            userData: join(
              root,
              phase === 'paste' ? 'paste-desktop-data' : 'desktop-data',
            ),
            main: resolve('out/main/index.js'),
            node: process.execPath,
          }),
        )
        let failure: unknown
        try {
          await execute(
            electron as unknown as string,
            [fileURLToPath(new URL('./editor-window.mjs', import.meta.url))],
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
      if (phases[0] === 'paste') return
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
