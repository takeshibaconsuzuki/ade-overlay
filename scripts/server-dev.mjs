import { spawn } from 'node:child_process'
import process from 'node:process'
import { buildSettingsBridge } from './settings-bridge-build.mjs'
import { stopProcess } from '../src/shared/node/process-lifecycle.ts'

// Rollup owns browser source watching; Node owns the server's module graph.
// The server reads the current bundle when an editor requests its bridge.
const stopped = Promise.withResolvers()
let watcher
let child
let exited
let stopping = false
const stop = () => {
  stopping = true
  stopped.resolve()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  watcher = await buildSettingsBridge(true)
  let ready
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        ready = (event) => {
          if (event.code === 'ERROR') reject(event.error)
          if (event.code === 'END') resolve()
        }
        watcher.on('event', ready)
      }),
      stopped.promise,
    ])
  } finally {
    watcher.off('event', ready)
  }
  if (!stopping) {
    child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--watch',
        'src/server/index.ts',
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit', windowsHide: true },
    )
    exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    const status = await Promise.race([exited, stopped.promise])
    process.exitCode = stopping ? 0 : (status ?? 1)
  }
} finally {
  await close()
}

async function close() {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  const results = await Promise.allSettled([
    watcher?.close(),
    (async () => {
      if (!child) return
      // Windows does not forward POSIX signals; retain its process-tree cleanup.
      if (process.platform === 'win32') await stopProcess(child)
      // Node's watcher forwards the signal and waits for accepted work to drain.
      else if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM')
      await exited
    })(),
  ])
  for (const result of results)
    if (result.status === 'rejected') throw result.reason
}
