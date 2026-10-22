import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runDesktopClient } from './harness'

test('interactive start command survives retries and visibility changes, restarts on disconnect, and stops on quit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-start-terminal-'))
  try {
    await runDesktopClient('start-command', {
      HOME: directory,
      USERPROFILE: directory,
      ADE_START_COMMAND_DATA: directory,
      ADE_START_COMMAND_NODE: process.execPath,
    })
    const pids = (await readFile(join(directory, 'pids'), 'utf8'))
      .trim()
      .split('\n')
      .map(Number)
    assert.ok(pids.length >= 2)
    for (const pid of pids)
      assert.throws(
        () => process.kill(pid, 0),
        'quit leaves no command running',
      )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
