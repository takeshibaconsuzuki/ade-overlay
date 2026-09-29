import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import electron from 'electron'
import { bundleMain } from '../helpers/bundle-main.ts'

for (const [scenario, name] of [
  [
    'chat-paste',
    'chat paste preserves text/image order and holds terminal paste until reservation',
  ],
  [
    'editor-paste',
    'editor paste IPC binds one-use reservations to the active document and original terminal',
  ],
])
  test(
    name,
    {
      timeout: 30_000,
      skip: process.platform === 'linux' && !process.env.DISPLAY,
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'ade-paste-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      if (scenario === 'chat-paste') {
        await bundleMain(root, 'chat-paste', 'editor-browser')
        await bundleMain(root, 'paste-content', 'editor-browser')
      } else {
        await bundleMain(root, 'editor-paste')
        await bundleMain(root, 'editor', 'preload')
      }
      await writeFile(join(root, 'index.html'), '<!doctype html><body></body>')
      const result = join(root, 'result.json')
      let failure: unknown
      try {
        await promisify(execFile)(
          electron as unknown as string,
          [fileURLToPath(new URL(`./${scenario}.mjs`, import.meta.url)), root],
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
            timeout: 25_000,
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
