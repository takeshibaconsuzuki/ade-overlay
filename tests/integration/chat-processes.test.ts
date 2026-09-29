import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { readChatProcesses } from '../../src/shared/node/chat-processes.ts'

test(
  'real process scans share bursts and discover processes launched afterwards',
  { timeout: 15_000 },
  async () => {
    const snapshots = await Promise.all(
      Array.from({ length: 12 }, () => readChatProcesses()),
    )
    assert.ok(snapshots.every((snapshot) => snapshot === snapshots[0]))
    assert.ok(snapshots[0].has(process.pid))
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    try {
      await once(child, 'spawn')
      const current = await readChatProcesses()
      assert.ok(current.has(child.pid!))
      assert.equal(current.get(child.pid!)!.parentPid, process.pid)
      assert.ok(current.get(child.pid!)!.startedAt)
    } finally {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  },
)
