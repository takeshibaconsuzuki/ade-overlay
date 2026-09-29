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

for (const [name, fixture] of [
  [
    'editor views track initial loads, background reloads, crashes and superseded navigation',
    'editor-window-retry.mjs',
  ],
  [
    'editor permissions allow user-initiated paste and microphone access in the active workbench',
    'editor-permissions.mjs',
  ],
  [
    'editor web links open in the desktop browser without replacing the workbench',
    'editor-links.mjs',
  ],
])
  test(
    name,
    {
      timeout: 30_000,
      skip: process.platform === 'linux' && !process.env.DISPLAY,
    },
    async (t) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'ade-window-')))
      t.after(async () => {
        assert.ok(
          resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep),
        )
        assert.ok(root.split(sep).at(-1)?.startsWith('ade-window-'))
        await rm(root, { recursive: true, force: true, maxRetries: 5 })
      })
      const editorModule = await bundleMain(root, 'editor-window')
      const result = join(root, 'result.json')
      const input = join(root, 'input.json')
      await writeFile(
        input,
        JSON.stringify({
          editorModule,
          result,
          userData: join(root, 'browser'),
        }),
      )
      let failure: unknown
      try {
        await promisify(execFile)(
          electron as unknown as string,
          [fileURLToPath(new URL(`./${fixture}`, import.meta.url))],
          {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: undefined,
              ADE_EDITOR_TEST_INPUT: input,
            },
            windowsHide: true,
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
      assert.equal(outcome.ok, true, JSON.stringify(outcome))
      if (failure) throw failure
    },
  )
