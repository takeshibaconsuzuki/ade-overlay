import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import electron from 'electron'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

test(
  'picker search resets results and respects window and dialog focus',
  {
    timeout: 40_000,
    skip: process.platform === 'linux' && !process.env.DISPLAY,
  },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ade-picker-')))
    t.after(async () => {
      assert.ok(
        resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep),
      )
      assert.ok(root.split(sep).at(-1)?.startsWith('ade-picker-'))
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    })
    await build({
      root: fileURLToPath(new URL('../../src/renderer', import.meta.url)),
      configFile: false,
      logLevel: 'silent',
      base: './',
      plugins: [react()],
      build: { outDir: join(root, 'renderer'), emptyOutDir: false },
    })
    const result = join(root, 'result.json')
    const input = join(root, 'input.json')
    await writeFile(input, JSON.stringify({ root, result }))
    let failure: unknown
    try {
      await promisify(execFile)(
        electron as unknown as string,
        [fileURLToPath(new URL('./worktree-picker.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: undefined,
            ADE_PICKER_TEST_INPUT: input,
          },
          windowsHide: true,
          timeout: 30_000,
        },
      )
    } catch (error) {
      failure = error
    }
    const outcome = JSON.parse(
      await readFile(result, 'utf8').catch((error: unknown) => {
        throw failure ?? error
      }),
    )
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    if (failure) throw failure
  },
)
