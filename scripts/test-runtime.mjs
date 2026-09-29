import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { delimiter, dirname, resolve } from 'node:path'
import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
} from '@vscode/test-electron'
import { EditorRuntimeManager } from '../src/server/editors/vscode-runtime.ts'
import { vscodeRelease } from '../src/server/editors/vscode-release.ts'

// Required release check: provision the same approved runtime as the companion.
// Missing downloads, CLI support, displays or runtime interfaces fail this job.
assert.ok(
  process.platform !== 'linux' || process.env.DISPLAY,
  'Run VS Code compatibility checks under a display, such as xvfb-run on Linux',
)
const executable =
  process.env.ADE_TEST_VSCODE_EXECUTABLE ??
  (await downloadAndUnzipVSCode(vscodeRelease.version))
const cli = resolveCliPathFromVSCodeExecutablePath(executable)
process.env.PATH = [dirname(cli), process.env.PATH].join(delimiter)
const runtimes = new EditorRuntimeManager(
  resolve('.vscode-test', 'ade-runtime'),
)
runtimes.on('progress', (message) => console.info(message))
try {
  const code = await runtimes.localCode()
  assert.equal(
    code.commit,
    vscodeRelease.commit,
    'Compatibility tests require the desktop build matching the approved server runtime',
  )
  const runtime = await runtimes.get()
  const env = {
    ...process.env,
    ADE_TEST_VSCODE_EXECUTABLE: executable,
    ADE_TEST_VSCODE_RUNTIME: dirname(dirname(runtime.entrypoint)),
    ELECTRON_RUN_AS_NODE: undefined,
  }
  for (const args of [
    ['--experimental-strip-types', '--test', 'tests/runtime/editors.test.ts'],
    ['scripts/test-extension.mjs'],
  ]) {
    const child = spawn(process.execPath, args, {
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (status) =>
        status === 0
          ? resolve()
          : reject(
              new Error(`VS Code compatibility check failed (${status}).`),
            ),
      )
    })
  }
} finally {
  await runtimes.close()
}
