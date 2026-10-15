import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VscodeTerminalInput } from '../src/workbench/terminal-input'

class Terminal {
  writes: unknown[] = []
  completion = Promise.resolve()
  raw = {
    _core: {
      coreService: {
        triggerDataEvent: (data: string, user = false) => {
          this.writes.push({ data, user })
        },
        triggerBinaryEvent: (data: string) => {
          this.writes.push({ binary: data })
        },
      },
    },
    paste: (text: string) => {
      this.raw._core.coreService.triggerDataEvent(text, true)
    },
  }
  sendText(text: string, addNewLine?: boolean, bracketedPasteMode?: boolean) {
    this.writes.push({ text, addNewLine, bracketedPasteMode })
    return this.completion
  }
}

test('runtime handlers defer user input while protocol replies and ADE pastes remain synchronous', async (t) => {
  const terminal = new Terminal()
  const queued: (() => void | Promise<void>)[] = []
  const adapter = new VscodeTerminalInput(terminal, terminal.raw, (send) => {
    queued.push(send)
    return Promise.resolve()
  })
  t.after(() => adapter.dispose())
  const core = terminal.raw._core.coreService
  core.triggerDataEvent('typed', true)
  void terminal.sendText('\x17', false, true)
  core.triggerBinaryEvent('binary')
  core.triggerDataEvent('protocol reply')
  adapter.paste('image path')
  assert.deepEqual(terminal.writes, [
    { data: 'protocol reply', user: false },
    { data: 'image path', user: true },
  ])
  assert.equal(queued.length, 3)
  for (const send of queued) await send()
  assert.deepEqual(terminal.writes.slice(2), [
    { data: 'typed', user: true },
    { text: '\x17', addNewLine: false, bracketedPasteMode: true },
    { binary: 'binary' },
  ])
})

test('sendText preserves immediate behavior and waits for deferred execution and completion', async (t) => {
  const terminal = new Terminal()
  let schedule: ConstructorParameters<typeof VscodeTerminalInput>[2] | undefined
  const adapter = new VscodeTerminalInput(terminal, terminal.raw, (send) =>
    schedule?.(send),
  )
  t.after(() => adapter.dispose())
  assert.equal(terminal.sendText('immediate'), terminal.completion)

  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  schedule = (send) => ready.then(send)
  let finish!: () => void
  terminal.completion = new Promise<void>((resolve) => {
    finish = resolve
  })
  let completed = false
  const pending = terminal.sendText('deferred', true).then(() => {
    completed = true
  })
  assert.equal(terminal.writes.length, 1)
  release()
  await ready
  assert.equal(terminal.writes.length, 2)
  assert.equal(completed, false)
  finish()
  await pending
  assert.equal(completed, true)

  schedule = () => Promise.resolve()
  await terminal.sendText('discarded')
  assert.equal(terminal.writes.length, 2)

  schedule = (send) => Promise.resolve().then(send)
  terminal.completion = Promise.reject(new Error('write failed'))
  await assert.rejects(terminal.sendText('failed'), /write failed/)
})

test('a failed ADE paste restores input scheduling', async (t) => {
  const terminal = new Terminal()
  const queued: unknown[] = []
  const adapter = new VscodeTerminalInput(terminal, terminal.raw, (send) => {
    queued.push(send)
    return Promise.resolve()
  })
  t.after(() => adapter.dispose())
  t.mock.method(terminal.raw, 'paste', () => {
    throw new Error('paste failed')
  })
  assert.throws(() => adapter.paste('bad image'), /paste failed/)
  terminal.raw._core.coreService.triggerDataEvent('typed', true)
  assert.equal(queued.length, 1)
  assert.deepEqual(terminal.writes, [])
})
