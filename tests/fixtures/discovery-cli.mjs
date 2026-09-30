import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const { mode, record } = JSON.parse(
  readFileSync(process.env.ADE_TEST_CLI_CONFIG, 'utf8'),
)
if (process.env.ADE_COMPANION_TOKEN || process.env.VSCODE_IPC_HOOK_CLI) {
  console.error('Parent credentials or routing leaked into CLI execution')
  process.exit(9)
}
if (mode === 'failure') {
  console.error('fixture CLI diagnosis')
  process.exitCode = 7
} else if (mode === 'oversized') {
  process.stdout.write('x'.repeat(70_000))
} else if (mode === 'waiting') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  writeFileSync(record, JSON.stringify([process.pid, child.pid]))
  setInterval(() => {}, 1000)
} else if (mode === 'uncommitted' && process.argv.includes('--version')) {
  console.log('Command is only available in a Visual Studio Code terminal.')
} else if (process.argv.includes('--version')) {
  console.log(`1.99.0\n${'a'.repeat(40)}\nx64`)
} else {
  console.log('--cli-data-dir --connection-token-file --commit-id')
}
