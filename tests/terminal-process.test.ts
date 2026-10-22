import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import {
  mkdtemp,
  rm,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { before, after, test, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'
import pRetry from 'p-retry'
import { NodeTerminalProcessFactory } from '../src/desktop/terminal-process'

let directory: string
let factory: NodeTerminalProcessFactory

before(async () => {
  // Keep the bundle inside the checkout so its external dependencies resolve.
  directory = await mkdtemp(resolve('.terminal-host-test-'))
  const entry = join(directory, 'host.cjs')
  await build({
    entryPoints: [resolve('src/desktop/terminal-host.ts')],
    outfile: entry,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    // Model a leaked worker that would keep the host alive after command exit.
    // The real host must still exit, without requiring node-pty to dispose it.
    banner: {
      js: `new (require('node:worker_threads').Worker)('setInterval(() => {}, 1000)', { eval: true });
process.send({ type: 'data', data: 'host=' + process.pid + '\\r\\n' });`,
    },
  })
  factory = new NodeTerminalProcessFactory(entry)
})

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

function start(command: string, onData: (data: string) => void = () => {}) {
  return factory.start(command, 80, 24, onData)
}

test(
  'resizing short-lived commands through exit never throws',
  { timeout: 10_000 },
  async () => {
    const errors: unknown[] = []
    for (let attempt = 0; attempt < 20; attempt++) {
      const command = start('echo done')
      let exited = false
      void command.exited.then(() => {
        exited = true
      })
      let cols = 80
      while (!exited) {
        try {
          command.resize(cols, 24)
        } catch (error) {
          errors.push(error)
        }
        cols = cols === 80 ? 81 : 80
        await setImmediate()
      }
      assert.equal((await command.exited).exitCode, 0)
    }
    assert.deepEqual(errors, [])
  },
)

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
  'commands find tools from login and interactive startup files with a minimal desktop PATH',
  {
    skip: process.platform === 'win32' || !existsSync('/bin/zsh'),
    timeout: 10_000,
  },
  async (t) => {
    const directory = await commandDirectory(t)
    await writeFile(
      join(directory, '.zprofile'),
      'export ADE_PROFILE_LOADED=profile\n',
    )
    await writeFile(
      join(directory, '.zshrc'),
      'export PATH="$ADE_TEST_BIN:$PATH"\n',
    )
    await writeFile(
      join(directory, 'ade-test-tool'),
      '#!/bin/sh\nprintf "found-%s\\n" "$ADE_PROFILE_LOADED"\n',
      { mode: 0o755 },
    )
    const script = join(directory, 'start.sh')
    await writeFile(script, '#!/bin/sh\nade-test-tool\n', { mode: 0o755 })

    // Exercise both an explicit shell and the OS login-shell fallback used when
    // the desktop was launched without SHELL in its environment.
    const shells =
      userInfo().shell === '/bin/zsh' ? ['/bin/zsh', undefined] : ['/bin/zsh']
    for (const shell of shells) {
      const original = process.env
      let output = ''
      let terminal
      try {
        process.env = {
          ...original,
          PATH: '/usr/bin:/bin',
          HOME: directory,
          ZDOTDIR: directory,
          ADE_TEST_BIN: directory,
        }
        if (shell) process.env.SHELL = shell
        else delete process.env.SHELL
        terminal = start(`"${script}"`, (data) => {
          output += data
        })
      } finally {
        process.env = original
      }
      t.after(() => terminal.stop())
      assert.equal((await terminal.exited).exitCode, 0, output)
      assert.match(output, /found-profile/)
    }
  },
)

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
    let output = ''
    const command = start(`"${process.execPath}" "${script}"`, (data) => {
      output += data
    })
    try {
      const pids: number[] = await pRetry(
        async () => JSON.parse(await readFile(marker, 'utf8')),
        {
          minTimeout: 20,
          maxTimeout: 100,
          retries: 50,
        },
      )
      pids.push(Number(/host=(\d+)/.exec(output)?.[1]))
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
  const command = start(`"${process.execPath}" "${script}" && echo complete`)
  try {
    assert.equal((await command.exited).exitCode, 0)
    assert.equal(await readFile(marker, 'utf8'), 'ready')
  } finally {
    await command.stop()
  }
})

test('start command exposes a nonzero exit status without rejecting after launch', async (t) => {
  const directory = await commandDirectory(t)
  const script = join(directory, 'fail.cjs')
  await writeFile(script, 'process.exit(23)')
  const command = start(`"${process.execPath}" "${script}"`)
  try {
    assert.equal((await command.exited).exitCode, 23)
  } finally {
    await command.stop()
  }
})

test('a missing executable is reported through the shell exit status', async () => {
  const command = start('ade-nonexistent-start-command-5c09e5b2')
  try {
    assert.notEqual((await command.exited).exitCode, 0)
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
    const command = start(`"${process.execPath}" "${script}"`)
    await command.stop()
    await command.exited
  },
)

test(
  'terminal supports prompts, raw input and resizing',
  { timeout: 10_000 },
  async (t) => {
    const directory = await commandDirectory(t)
    const script = join(directory, 'interactive.cjs')
    await writeFile(
      script,
      `
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(20);
process.stdin.setRawMode(true);
process.stdout.write('Password: ');
process.stdin.on('data', data => {
  process.stdout.write('input=' + data.toString('hex') + '\\r\\n');
  process.stdout.write('size=' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');
  if (data.includes(3)) process.exit(0);
});
`,
    )
    let output = ''
    const command = start(`"${process.execPath}" "${script}"`, (data) => {
      output += data
    })
    t.after(() => command.stop())
    const expect = (pattern: RegExp) =>
      pRetry(() => assert.match(output, pattern), {
        minTimeout: 20,
        maxTimeout: 100,
        retries: 50,
      })
    await expect(/Password:/)
    command.resize(110, 32)
    command.write('secret\r')
    await expect(/input=7365637265740d/)
    await expect(/size=110x32/)
    command.write('\x1b[A\x1b\x03')
    await expect(/input=1b5b411b03/)
    assert.equal((await command.exited).exitCode, 0)
  },
)

test(
  'each terminal host exits despite a surviving worker and preserves final output and status',
  { timeout: 15_000 },
  async (t) => {
    for (const exitCode of [0, 23, 0]) {
      const script = join(directory, 'exit.cjs')
      await writeFile(
        script,
        `
if (process.env.ELECTRON_RUN_AS_NODE) process.exit(99);
if (${exitCode} !== 0) process.stdout.write('final output\\r\\n'.repeat(8192));
process.exitCode = ${exitCode};
`,
      )
      let output = ''
      const terminal = factory.start(
        `"${process.execPath}" "${script}"`,
        80,
        24,
        (data) => {
          output += data
        },
      )
      t.after(() => terminal.stop())
      terminal.resize(100, 30)
      assert.equal((await terminal.exited).exitCode, exitCode)
      const hostPid = Number(/host=(\d+)/.exec(output)?.[1])
      assert.ok(hostPid > 0)
      assert.throws(
        () => process.kill(hostPid, 0),
        'host and its worker must be gone before the next launch',
      )
      if (exitCode !== 0)
        assert.equal(output.match(/final output/g)?.length, 8192)
      assert.doesNotThrow(() => {
        terminal.resize(120, 40)
        terminal.write('after exit')
      })
      await terminal.stop()
    }
  },
)
