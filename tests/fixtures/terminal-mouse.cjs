/* eslint @typescript-eslint/no-require-imports: "off" -- Runs inside a real terminal. */
const { appendFileSync } = require('node:fs')

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\x1b[?1003h\x1b[?1006hADE_MOUSE_READY\r\n')
process.stdin.on('data', (data) => {
  appendFileSync(
    'mouse-events.jsonl',
    JSON.stringify({ pid: process.pid, data: data.toString() }) + '\n',
  )
  if (data.includes(113)) {
    process.stdout.write('\x1b[?1003l\x1b[?1006l')
    process.stdin.setRawMode(false)
    process.exit(0)
  }
})
