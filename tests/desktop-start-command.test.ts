import assert from 'node:assert/strict'
import {
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import pRetry from 'p-retry'
import { DesktopStartCommand } from '../src/desktop/start-command'

async function commandDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ade-start-command-'))
  t.after(async () => {
    for (const file of await readdir(directory))
      await unlink(join(directory, file))
    await rmdir(directory)
  })
  return directory
}

test(
  'start command returns while running and stop terminates its process tree',
  { timeout: 10_000 },
  async (t) => {
    const directory = await commandDirectory(t)
    const script = join(directory, 'setup command.cjs')
    const marker = join(directory, 'ready')
    await writeFile(
      script,
      `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, descendant.pid]));
setInterval(() => {}, 1000);`,
    )
    const command = new DesktopStartCommand(`"${process.execPath}" "${script}"`)
    try {
      await command.started
      const pids: number[] = await pRetry(
        async () => JSON.parse(await readFile(marker, 'utf8')),
        {
          minTimeout: 20,
          maxTimeout: 100,
          retries: 50,
        },
      )
      for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0))
      const stopped = command.stop()
      assert.equal(command.stop(), stopped)
      await stopped
      await pRetry(
        () => {
          for (const pid of pids) assert.throws(() => process.kill(pid, 0))
        },
        { minTimeout: 20, maxTimeout: 100, retries: 50 },
      )
      assert.equal(command.stop(), stopped)
    } finally {
      await command.stop()
    }
  },
)

test('completed setup commands support shell composition and remain safe to stop', async (t) => {
  const directory = await commandDirectory(t)
  const script = join(directory, 'setup command.cjs')
  const marker = join(directory, 'ready')
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready')`,
  )
  const command = new DesktopStartCommand(
    `"${process.execPath}" "${script}" && echo complete`,
  )
  try {
    await command.started
    assert.equal((await command.exited).code, 0)
    assert.equal(await readFile(marker, 'utf8'), 'ready')
  } finally {
    await command.stop()
  }
})

test('start command exposes a nonzero exit status without rejecting after launch', async (t) => {
  const directory = await commandDirectory(t)
  const script = join(directory, 'fail.cjs')
  await writeFile(script, 'process.exit(23)')
  const command = new DesktopStartCommand(`"${process.execPath}" "${script}"`)
  try {
    await command.started
    assert.equal((await command.exited).code, 23)
  } finally {
    await command.stop()
  }
})

test('a missing executable is reported through the shell exit status', async () => {
  const command = new DesktopStartCommand(
    'ade-nonexistent-start-command-5c09e5b2',
  )
  try {
    await command.started
    assert.notEqual((await command.exited).code, 0)
  } finally {
    await command.stop()
  }
})

test(
  'shutdown can stop a command immediately after launch',
  { timeout: 5000 },
  async (t) => {
    const directory = await commandDirectory(t)
    const script = join(directory, 'pending.cjs')
    await writeFile(script, 'setInterval(() => {}, 1000)')
    const command = new DesktopStartCommand(`"${process.execPath}" "${script}"`)
    await Promise.all([command.started, command.stop()])
    await command.exited
  },
)
