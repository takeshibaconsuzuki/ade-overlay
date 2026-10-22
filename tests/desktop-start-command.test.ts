import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { DesktopStartCommand } from '../src/desktop/start-command'
import type {
  TerminalProcess,
  TerminalProcessFactory,
} from '../src/desktop/terminal-process'

class TestTerminal implements TerminalProcess {
  private resolveExit!: (event: { exitCode: number }) => void
  readonly exited = new Promise<{ exitCode: number }>((resolve) => {
    this.resolveExit = resolve
  })
  stops = 0
  input = ''
  size: number[] = []
  termination: Promise<void> = Promise.resolve()

  finish(code = 0): void {
    this.resolveExit({ exitCode: code })
  }

  write(data: string): void {
    this.input += data
  }

  resize(cols: number, rows: number): void {
    this.size = [cols, rows]
  }

  stop(): Promise<void> {
    this.stops++
    this.finish()
    return this.termination
  }
}

class TestFactory implements TerminalProcessFactory {
  readonly terminals: TestTerminal[] = []
  onData: (data: string) => void = () => {}
  fail = false

  start(
    _command: string,
    cols: number,
    rows: number,
    onData: (data: string) => void,
  ): TerminalProcess {
    if (this.fail) throw new Error('spawn failed')
    this.onData = onData
    const terminal = new TestTerminal()
    terminal.resize(cols, rows)
    this.terminals.push(terminal)
    return terminal
  }
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const factory = new TestFactory()
  const output: string[] = []
  const command = new DesktopStartCommand('test', factory, (data) =>
    output.push(data),
  )
  t.after(() => command.close())
  const restart = async () => {
    await setImmediate()
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  return { factory, command, output, restart }
}

test('only connected-to-disconnected transitions kill the command; retries and connects leave it running', async (t) => {
  const { factory, command, restart } = setup(t)
  const first = factory.terminals[0]
  for (const state of [
    'connecting',
    'retrying',
    'connecting',
    'retrying',
    'connected',
    'connected',
  ] as const)
    command.connectionChanged(state)
  assert.equal(first.stops, 0)
  command.connectionChanged('retrying')
  command.connectionChanged('connecting')
  command.connectionChanged('retrying')
  assert.equal(first.stops, 1)
  await restart()
  const second = factory.terminals[1]
  assert.ok(second)
  command.connectionChanged('connecting')
  command.connectionChanged('retrying')
  assert.equal(second.stops, 0)
  command.connectionChanged('connected')
  command.connectionChanged('retrying')
  assert.equal(second.stops, 1)
})

test('normal and failed exits restart while connected without killing either command', async (t) => {
  const { factory, command, restart } = setup(t)
  command.connectionChanged('connected')
  for (const code of [0, 23]) {
    const terminal = factory.terminals.at(-1)!
    terminal.finish(code)
    await restart()
    assert.equal(terminal.stops, 0)
  }
  assert.equal(factory.terminals.length, 3)
})

test('each launch displays the command before its output and retains it for initialization', async (t) => {
  const { factory, command, output, restart } = setup(t)
  assert.equal(output[0], '[startCommand] Running: test\r\n')
  factory.onData('Password: ')
  assert.match(command.history, /Running: test\r\nPassword: /)
  factory.terminals[0].finish()
  await restart()
  factory.onData('Password: ')
  assert.match(output.at(-2)!, /Running: test/)
  assert.equal(output.at(-1), 'Password: ')
  assert.equal(command.history.match(/Running: test/g)?.length, 2)
})

test('restart waits for termination and quit prevents a replacement', async (t) => {
  const { factory, command, restart } = setup(t)
  const terminal = factory.terminals[0]
  let finishTermination!: () => void
  terminal.termination = new Promise((resolve) => {
    finishTermination = resolve
  })
  command.connectionChanged('connected')
  command.connectionChanged('retrying')
  await restart()
  assert.equal(factory.terminals.length, 1)
  const closed = command.close()
  finishTermination()
  await closed
  await restart()
  assert.equal(factory.terminals.length, 1)
})

test('quit cancels pending retries and connection changes cannot revive the loop', async (t) => {
  const { factory, command, restart } = setup(t)
  factory.terminals[0].finish()
  await setImmediate()
  await command.close()
  command.connectionChanged('connected')
  command.connectionChanged('retrying')
  await restart()
  assert.equal(factory.terminals.length, 1)
  assert.equal(factory.terminals[0].stops, 0)
})

test('quit terminates a running command and never restarts it', async (t) => {
  const { factory, command, restart } = setup(t)
  await command.close()
  await restart()
  assert.equal(factory.terminals[0].stops, 1)
  assert.equal(factory.terminals.length, 1)
})

test('spawn failures are displayed and retried', async (t) => {
  const { factory, command, restart } = setup(t)
  factory.fail = true
  factory.terminals[0].finish()
  await restart()
  assert.match(command.history, /spawn failed/)
  factory.fail = false
  await restart()
  assert.equal(factory.terminals.length, 2)
})

test('input and size follow the current process and history is bounded', async (t) => {
  const { factory, command, output, restart } = setup(t)
  command.write('password\r')
  command.resize(120, 35)
  assert.equal(factory.terminals[0].input, 'password\r')
  assert.deepEqual(factory.terminals[0].size, [120, 35])
  factory.onData('x'.repeat(300_000))
  factory.onData('prompt')
  assert.equal(command.history.length, 256_000)
  assert.ok(command.history.endsWith('prompt'))
  assert.equal(output.at(-1), 'prompt')
  factory.terminals[0].finish()
  await restart()
  assert.deepEqual(factory.terminals[1].size, [120, 35])
})
