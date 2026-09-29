import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { providerShellCommand } from '../../extensions/ade-terminals/src/provider-command.ts'

test('provider wrapper waits for the command, handles trailing comments and exits its shell', async () => {
  const windows = process.platform === 'win32'
  const shell = windows ? 'powershell.exe' : '/bin/sh'
  const command = windows
    ? "Start-Sleep -Milliseconds 100; Write-Output 'provider done' # comment"
    : "sleep 0.1; echo 'provider done' # comment"
  const script = providerShellCommand(command, shell) + '\necho should-not-run'
  const result = await promisify(execFile)(
    shell,
    windows
      ? ['-NoProfile', '-NonInteractive', '-Command', script]
      : ['-c', script],
    { windowsHide: true, timeout: 10_000 },
  )
  assert.equal(result.stdout.trim(), 'provider done')
})

test(
  'Command Prompt provider terminals exit after the configured command',
  { skip: process.platform !== 'win32' },
  async () => {
    const script =
      providerShellCommand('echo provider done', 'cmd.exe') +
      ' & echo should-not-run'
    const result = await promisify(execFile)('cmd.exe', ['/d', '/c', script], {
      windowsHide: true,
      timeout: 10_000,
    })
    assert.equal(result.stdout.trim(), 'provider done')
  },
)
