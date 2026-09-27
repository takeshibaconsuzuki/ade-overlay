// A real long-lived process with the provider executable name, without model calls.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const hook = JSON.parse(readFileSync(process.env.ADE_CHAT_TEST_HOOKS, 'utf8'))
  .hooks.SessionStart[0].hooks[0]
const windows = process.platform === 'win32'
const child = spawn(
  windows
    ? join(
        process.env.SystemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
    : '/bin/sh',
  windows
    ? ['-NoProfile', '-NonInteractive', '-Command', hook.commandWindows]
    : ['-c', hook.command],
  { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
)
child.stdin.end(
  JSON.stringify({ hook_event_name: 'SessionStart', session_id: randomUUID() }),
)
setInterval(() => {
  if (existsSync('finish-provider')) process.exit(0)
}, 100)
