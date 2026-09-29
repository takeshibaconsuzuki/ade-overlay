import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { codeEnvironment } from '../../src/server/editors/code-cli.ts'

test('editor bootstrap under a watched companion limits credentials to extension hosts, including hosts started later', async (t) => {
  const original = process.env
  t.after(() => {
    process.env = original
  })
  process.env = { ...original, WATCH_REPORT_DEPENDENCIES: '1' }
  const root = await mkdtemp(join(tmpdir(), 'ade-bootstrap-'))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const probe = join(root, 'probe.mjs')
  await writeFile(
    probe,
    `process.send({ token: process.env.ADE_CHAT_EXTENSION_TOKEN, activity: process.env.ADE_CHAT_ACTIVITY_TOKEN }); process.disconnect();`,
  )
  const runtime = join(root, 'server.mjs')
  await writeFile(
    runtime,
    `
    import assert from 'node:assert/strict';
    import { fork } from 'node:child_process';
    import { once } from 'node:events';
    assert.equal(process.env.ADE_CHAT_EXTENSION_TOKEN, undefined);
    for (const extension of [false, true, false, true]) {
      const child = fork(${JSON.stringify(probe)}, extension ? ['--type=extensionHost'] : [], {
        env: { ...process.env, VSCODE_ESM_ENTRYPOINT: extension ? 'vs/workbench/api/node/extensionHostProcess' : 'vs/platform/terminal/node/ptyHostMain' },
      });
      const [result] = await once(child, 'message');
      assert.equal(result.token, extension ? 'a'.repeat(64) : undefined);
      assert.equal(result.activity, 'activity');
      await once(child, 'exit');
    }
    assert.equal(process.argv[1], ${JSON.stringify(runtime)});
  `,
  )
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          '../../src/server/editors/editor-bootstrap.ts',
          import.meta.url,
        ),
      ),
      runtime,
    ],
    {
      env: {
        ...codeEnvironment(),
        ADE_CHAT_EXTENSION_TOKEN: undefined,
        ADE_CHAT_ACTIVITY_TOKEN: 'activity',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  let output = ''
  child.stdout!.on('data', (data) => (output += data))
  child.stderr!.on('data', (data) => (output += data))
  child.send('a'.repeat(64))
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output)
})
