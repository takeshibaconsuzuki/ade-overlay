import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import electron from 'electron'
import { bundleMain } from '../helpers/bundle-main.ts'

test(
  'Windows picker dismissal restores an external window without undoing a focus change',
  {
    timeout: 30_000,
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ade-focus-')))
    t.after(async () => {
      assert.ok(
        resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep),
      )
      assert.ok(root.split(sep).at(-1)?.startsWith('ade-focus-'))
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    })
    const pickerModule = await bundleMain(root, 'picker-window')
    const focusModule = await bundleMain(root, 'window-focus')
    const result = join(root, 'result.json')
    const input = join(root, 'input.json')
    await writeFile(
      input,
      JSON.stringify({ root, pickerModule, focusModule, result }),
    )
    let failure: unknown
    try {
      await promisify(execFile)(
        electron as unknown as string,
        [fileURLToPath(new URL('./picker-window-focus.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: undefined,
            ADE_FOCUS_TEST_INPUT: input,
          },
          windowsHide: false,
          timeout: 25_000,
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
    assert.equal(
      outcome.ok,
      true,
      JSON.stringify(outcome) +
        String((failure as { stderr?: string })?.stderr ?? ''),
    )
    if (failure) throw failure
  },
)
