import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { stopProcess } from '../../src/shared/node/process-lifecycle.ts'

test('owned process termination does not wait for SIGTERM handlers', async (t) => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `process.on('SIGTERM', () => {});
       setInterval(() => {}, 1000);
       process.send('ready');`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
  )
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
    await closed
  })
  await once(child, 'message', { signal: AbortSignal.timeout(5000) })
  await Promise.all([
    stopProcess(child),
    once(child, 'close', { signal: AbortSignal.timeout(5000) }),
  ])
  if (process.platform !== 'win32') assert.equal(child.signalCode, 'SIGKILL')
})
