import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Socket } from 'node:net'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import type { IPty } from 'node-pty'
import type { TerminalHostEvent } from '../src/desktop/terminal-process'

const require = createRequire(import.meta.url)
const hostCode = buildSync({
  entryPoints: ['src/desktop/terminal-host.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text
interface ExitedAgent {
  _$onProcessExit(code: number): void
}
const { WindowsPtyAgent } = require('node-pty/lib/windowsPtyAgent') as {
  WindowsPtyAgent: { prototype: ExitedAgent }
}

// Run the actual WindowsTerminal constructor and deferred callbacks. Substitute
// only native process creation so these event orderings also run on macOS/Linux.
function windowsTerminal() {
  const input = new Socket()
  const output = new Socket()
  const sizes: number[][] = []
  const agent = Object.assign(Object.create(WindowsPtyAgent.prototype), {
    _useConpty: true,
    _useConptyDll: false,
    _inSocket: input,
    _outSocket: output,
    _innerPid: 123,
    _pty: 1,
    _ptyNative: {
      resize: (_id: number, cols: number, rows: number) =>
        sizes.push([cols, rows]),
    },
  }) as ExitedAgent
  const filename = require.resolve('node-pty/lib/windowsTerminal')
  const localRequire = createRequire(filename)
  const exports: { WindowsTerminal?: new () => IPty } = {}
  runInNewContext(readFileSync(filename, 'utf8'), {
    exports,
    process,
    console,
    require: (name: string) =>
      name === './windowsPtyAgent'
        ? {
            WindowsPtyAgent: class {
              constructor() {
                return agent
              }
            },
          }
        : localRequire(name),
  })
  const pty = new exports.WindowsTerminal!()
  const received: string[] = []
  const hostProcess = Object.assign(new EventEmitter(), {
    platform: 'win32',
    env: { ...process.env },
    cwd: () => process.cwd(),
    send: (event: TerminalHostEvent, done: () => void) => {
      if (event.type === 'data') received.push(event.data)
      else hostProcess.emit('result', event)
      done()
    },
    exit: () => {},
  })
  const exited = new Promise<{ exitCode: number }>((resolve) =>
    hostProcess.once('result', resolve),
  )
  runInNewContext(hostCode, {
    process: hostProcess,
    console,
    queueMicrotask,
    Error,
    require: (name: string) =>
      name === 'node-pty' ? { spawn: () => pty } : require(name),
  })
  hostProcess.emit('message', {
    type: 'start',
    command: 'echo done',
    cols: 80,
    rows: 24,
  })
  const terminal = {
    exited,
    resize: (cols: number, rows: number) =>
      hostProcess.emit('message', { type: 'resize', cols, rows }),
  }
  output.emit('ready_datapipe')
  return {
    terminal,
    agent,
    input,
    output,
    sizes,
    received,
  }
}

for (const exitBeforeOutput of [false, true]) {
  test(`Windows resize is safe when exit ${exitBeforeOutput ? 'precedes' : 'follows'} the first output`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { terminal, agent, input, output, sizes, received } =
      windowsTerminal()
    t.after(() => {
      input.destroy()
      output.destroy()
    })
    terminal.resize(100, 30)
    terminal.resize(120, 40)
    assert.deepEqual(sizes, [])
    if (exitBeforeOutput) agent._$onProcessExit(23)
    // node-pty forwards onData before marking itself ready. A resize submitted
    // before this event used to throw later, outside our wrapper's try/catch.
    assert.doesNotThrow(() => output.emit('data', 'last output'))
    await Promise.resolve()
    assert.deepEqual(sizes, exitBeforeOutput ? [] : [[120, 40]])
    if (!exitBeforeOutput) agent._$onProcessExit(0)
    assert.doesNotThrow(() => terminal.resize(140, 50))
    assert.deepEqual(sizes, exitBeforeOutput ? [] : [[120, 40]])
    t.mock.timers.tick(1000)
    assert.equal((await terminal.exited).exitCode, exitBeforeOutput ? 23 : 0)
    assert.deepEqual(received, ['last output'])
  })
}

test('Windows silent exits discard pending resizes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { terminal, agent, input, output, sizes } = windowsTerminal()
  t.after(() => {
    input.destroy()
    output.destroy()
  })
  terminal.resize(100, 30)
  agent._$onProcessExit(0)
  t.mock.timers.tick(1000)
  assert.equal((await terminal.exited).exitCode, 0)
  terminal.resize(120, 40)
  assert.deepEqual(sizes, [])
})
