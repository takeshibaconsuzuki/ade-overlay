import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import electron from 'electron'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

test(
  'sidebar renders provider content and skeletons, switches provider, launches and navigates',
  {
    timeout: 40_000,
    skip: process.platform === 'linux' && !process.env.DISPLAY,
  },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ade-sidebar-')))
    t.after(async () => {
      assert.ok(
        resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep),
      )
      assert.ok(root.split(sep).at(-1)?.startsWith('ade-sidebar-'))
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    })
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [react()],
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: join(root, 'assets'),
        lib: {
          entry: fileURLToPath(
            new URL(
              '../extensions/ade-terminals/src/webview/index.tsx',
              import.meta.url,
            ),
          ),
          formats: ['iife'],
          name: 'AdeSidebar',
          fileName: () => 'sidebar.js',
          cssFileName: 'sidebar',
        },
      },
    })
    const screenshot = resolve('out/sidebar-preview.png')
    await mkdir(resolve('out'), { recursive: true })
    const input = join(root, 'input.json')
    const result = join(root, 'result.json')
    await writeFile(input, JSON.stringify({ root, result, screenshot }))
    let failure: unknown
    try {
      await promisify(execFile)(
        electron as unknown as string,
        [fileURLToPath(new URL('./fixtures/sidebar.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: undefined,
            ADE_SIDEBAR_TEST_INPUT: input,
          },
          windowsHide: true,
          timeout: 30_000,
        },
      )
    } catch (error) {
      failure = error
    }
    const outcome = JSON.parse(
      await readFile(result, 'utf8').catch((error) => {
        throw failure ?? error
      }),
    )
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    if (failure) throw failure
  },
)
