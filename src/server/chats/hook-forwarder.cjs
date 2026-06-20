const http = require('node:http')
const { execFileSync } = require('node:child_process')

const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  let raw = Buffer.concat(chunks)
  const pids = []
  const seen = new Set()
  let pid = process.pid
  while (pid && !seen.has(pid)) {
    seen.add(pid)
    pids.push(pid)
    try {
      const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 200,
      }).trim()
      pid = Number.parseInt(out, 10) || 0
    } catch {
      pid = 0
    }
  }

  try {
    const data = JSON.parse(raw.length ? raw.toString('utf8') : '{}')
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      data._ade_overlay = {
        hook_pid: process.pid,
        hook_ppid: process.ppid,
        hook_ancestor_pids: pids,
      }
      raw = Buffer.from(JSON.stringify(data))
    }
  } catch {}

  const url = new URL(process.argv[2])
  if (process.argv[3]) {
    url.searchParams.set('worktreeId', process.argv[3])
  }

  const req = http.request(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': raw.length,
      },
      timeout: 1000,
    },
    (res) => {
      res.resume()
      res.on('end', () => process.exit(0))
    },
  )
  req.on('timeout', () => req.destroy())
  req.on('error', () => process.exit(0))
  req.end(raw)
})
