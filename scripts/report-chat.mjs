// Usage: node report-chat.mjs <provider-id> <owning-executable-name>
// Reads a provider's JSON event on stdin and forwards it with its owning PID.
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const [provider, executable] = process.argv.slice(2)
// TODO: Take the server address from an environment variable.
const address = 'http://127.0.0.1:4317'

async function findOwner() {
  const options = {
    timeout: 1800,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  }
  let entries
  if (process.platform === 'win32') {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
      ],
      options,
    )
    entries = [].concat(JSON.parse(stdout)).map((entry) => ({
      pid: entry.ProcessId,
      parentPid: entry.ParentProcessId,
      name: entry.Name,
    }))
  } else {
    const { stdout } = await exec(
      'ps',
      ['-A', '-o', 'pid=,ppid=,comm='],
      options,
    )
    entries = stdout
      .trim()
      .split('\n')
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
        return (
          match && {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            name: match[3],
          }
        )
      })
      .filter(Boolean)
  }
  const normalize = (name) =>
    process.platform === 'win32'
      ? basename(name)
          .toLowerCase()
          .replace(/\.exe$/, '')
      : basename(name)
  const seen = new Set()
  let pid = process.ppid
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid)
    const entry = entries.find((entry) => entry.pid === pid)
    if (!entry) break
    if (normalize(entry.name) === normalize(executable)) return pid
    pid = entry.parentPid
  }
  throw new Error('No owning process found')
}

async function main() {
  if (!provider || !executable) throw new Error('Missing reporter arguments')
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > 1024 * 1024) return
  }
  const payload = JSON.parse(input)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  const pid = await findOwner()
  await fetch(`${address}/chats/report/${encodeURIComponent(provider)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      pid,
      terminalId: process.env.ADE_TERMINAL_ID || undefined,
    }),
    signal: AbortSignal.timeout(1000),
  })
}

// Reporting is advisory; failures must not block the provider.
const deadline = setTimeout(() => process.exit(0), 2500)
void main()
  .catch(() => {})
  .finally(() => clearTimeout(deadline))
