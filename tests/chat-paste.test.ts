import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  ChatPaste,
  type ChatPasteClipboard,
  type ChatPasteGroup,
  type ChatPasteTerminal,
  type ChatPasteTerminals,
} from '../src/workbench/chat-paste'
import { createChatTerminals } from '../src/workbench/chat-terminals'
import type { WorkbenchServices } from '../src/workbench/services'
import type { DesktopWorkbenchMethods } from '../src/shared/editor-rpc'

class Clipboard implements ChatPasteClipboard {
  nativePastes = 0
  paste: ChatPasteClipboard['paste'] = async () => {
    this.nativePastes++
  }
}

class Terminal implements ChatPasteTerminal {
  readonly resource = {}
  processId = 123
  isDisposed = false
  xtermReadyPromise = Promise.resolve()
  clipboard = new Clipboard()
  texts: string[] = []
  xterm = {
    raw: {
      modes: { bracketedPasteMode: true },
      options: { ignoreBracketedPasteMode: false },
      paste: (text: string) => this.texts.push(text),
    },
  }
  getContribution() {
    return this.clipboard
  }
}

class Terminals implements ChatPasteTerminals {
  created: (terminal: ChatPasteTerminal) => void = () => {}
  removed: (terminal: ChatPasteTerminal) => void = () => {}
  instances = [new Terminal(), new Terminal()]
  onDidCreateInstance(listener: typeof this.created) {
    this.created = listener
    return { dispose() {} }
  }
  onDidDisposeInstance(listener: typeof this.removed) {
    this.removed = listener
    return { dispose() {} }
  }
}

class Group implements ChatPasteGroup {
  resources = new Set<unknown>()
  owns(resource: unknown) {
    return this.resources.has(resource)
  }
}

class Services implements WorkbenchServices {
  readonly notifications: string[] = []
  constructor(readonly terminals: ChatPasteTerminals) {}
  get(id: string) {
    if (id === 'terminalService') return this.terminals
    if (id === 'notificationService')
      return {
        error: (message: string) => this.notifications.push(message),
      }
    assert.fail(`Unexpected service ${id}`)
  }
  async executeCommand() {}
  registerCommand() {
    return { dispose() {} }
  }
}

class Desktop implements DesktopWorkbenchMethods {
  constructor(
    readonly prepareChatPaste: DesktopWorkbenchMethods['prepareChatPaste'],
  ) {}
  async getDisabledExtensions() {
    return []
  }
  async settingsChanged() {}
  ready() {}
  startupFailed() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

test('only chat terminals use prepared paste events; unsupported snapshots insert nothing', async (t) => {
  const terminals = new Terminals()
  const group = new Group()
  group.resources.add(terminals.instances[0].resource)
  let prepared = 0
  let text = ['converted']
  const paste = new ChatPaste(
    new Services(terminals),
    group,
    new Desktop(async (pid) => {
      assert.equal(pid, 123)
      prepared++
      return text
    }),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  await terminals.instances[1].clipboard.paste()
  assert.equal(prepared, 0)
  assert.equal(terminals.instances[1].clipboard.nativePastes, 1)
  await terminals.instances[0].clipboard.paste()
  assert.deepEqual(terminals.instances[0].texts, ['converted'])
  text = []
  await terminals.instances[0].clipboard.paste()
  assert.equal(terminals.instances[0].clipboard.nativePastes, 0)
  assert.deepEqual(terminals.instances[0].texts, ['converted'])
})

test('an ordinary terminal in the owned group retains native paste without waiting for the chat queue', async (t) => {
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const services = new Services(terminals)
  const conversion = deferred<string[]>()
  let calls = 0
  const paste = new ChatPaste(
    services,
    group,
    new Desktop(async () => (calls++ === 0 ? conversion.promise : undefined)),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  const pendingChatPaste = terminal.clipboard.paste()
  const nativePaste = terminal.clipboard.paste()
  await setImmediate()
  assert.equal(terminal.clipboard.nativePastes, 1)
  assert.deepEqual(terminal.texts, [])
  assert.deepEqual(services.notifications, [])
  conversion.resolve(['prepared chat content'])
  await Promise.all([pendingChatPaste, nativePaste])
  assert.deepEqual(terminal.texts, ['prepared chat content'])
})

test('moving a terminal out of the group, closing it, or disconnecting cancels prepared paste', async (t) => {
  t.mock.method(console, 'error', () => {})
  for (const reason of ['move', 'close', 'disconnect']) {
    const terminals = new Terminals()
    const terminal = terminals.instances[0]
    const group = new Group()
    group.resources.add(terminal.resource)
    const services = new Services(terminals)
    const prepared = deferred<string[]>()
    const paste = new ChatPaste(
      services,
      group,
      new Desktop(() => prepared.promise),
    )
    await setImmediate()
    const pending = terminal.clipboard.paste()
    if (reason === 'move') group.resources.clear()
    if (reason === 'close') terminal.isDisposed = true
    if (reason === 'disconnect') paste.dispose()
    prepared.resolve(['must not paste'])
    await pending
    assert.deepEqual(terminal.texts, [])
    assert.equal(terminal.clipboard.nativePastes, 0)
    assert.equal(services.notifications.length, 1)
    paste.dispose()
  }
})

test('parallel conversion preserves paste order and a failed conversion does not poison the queue', async (t) => {
  t.mock.method(console, 'error', () => {})
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const services = new Services(terminals)
  const conversions = [deferred<string[]>(), deferred<string[]>()]
  let next = 0
  const paste = new ChatPaste(
    services,
    group,
    new Desktop(() => conversions[next++].promise),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  const first = terminal.clipboard.paste()
  const second = terminal.clipboard.paste()
  conversions[1].resolve(['second'])
  await setImmediate()
  assert.deepEqual(terminal.texts, [])
  conversions[0].reject(new Error('failed image'))
  await Promise.all([first, second])
  assert.equal(services.notifications.length, 1)
  assert.deepEqual(terminal.texts, ['second'])
  assert.equal(terminal.clipboard.nativePastes, 0)
})

test('an unrelated terminal failing to initialize cannot produce a chat-paste error', async (t) => {
  const terminals = new Terminals()
  terminals.instances[0].xtermReadyPromise = Promise.reject(
    new Error('invalid shell'),
  )
  const services = new Services(terminals)
  const paste = new ChatPaste(
    services,
    new Group(),
    new Desktop(async () => []),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  assert.deepEqual(services.notifications, [])
})

test('plain text preparation starts while earlier image conversion is pending and retains its captured content', async (t) => {
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const services = new Services(terminals)
  const conversion = deferred<string[]>()
  let copied = 'initial'
  let calls = 0
  const paste = new ChatPaste(
    services,
    group,
    new Desktop(async () => {
      const text = copied
      if (calls++ === 0) return conversion.promise
      return [text]
    }),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  const imagePaste = terminal.clipboard.paste()
  await setImmediate()
  copied = 'requested text'
  const textPaste = terminal.clipboard.paste()
  await setImmediate()
  assert.equal(calls, 2)
  copied = 'newer copy'
  assert.deepEqual(terminal.texts, [])
  conversion.resolve(['before', '"/image.png"', 'after'])
  await Promise.all([imagePaste, textPaste])
  assert.deepEqual(terminal.texts, [
    'before',
    '"/image.png"',
    'after',
    'requested text',
  ])
  assert.equal(terminal.clipboard.nativePastes, 0)
})

test('a terminal leaving the locked group during a multi-part paste cancels the remaining events', async (t) => {
  t.mock.method(console, 'error', () => {})
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const services = new Services(terminals)
  const paste = new ChatPaste(
    services,
    group,
    new Desktop(async () => ['before', '"/image.png"', 'after']),
  )
  t.after(() => paste.dispose())
  t.mock.method(terminal.xterm.raw, 'paste', (text: string) => {
    terminal.texts.push(text)
    group.resources.clear()
  })
  await setImmediate()
  await terminal.clipboard.paste()
  assert.deepEqual(terminal.texts, ['before'])
  assert.equal(services.notifications.length, 1)
})

test('chat paste inserts separate events synchronously without using native paste confirmation', async (t) => {
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const paste = new ChatPaste(
    new Services(terminals),
    group,
    new Desktop(async () => ['first\nline', '"/image.png"', 'last']),
  )
  t.after(() => paste.dispose())
  t.mock.method(terminal.xterm.raw, 'paste', (text: string) => {
    terminal.texts.push(text)
    // A microtask must not run between parts of one insertion.
    queueMicrotask(() => group.resources.clear())
  })
  await setImmediate()
  await terminal.clipboard.paste()
  assert.deepEqual(terminal.texts, ['first\nline', '"/image.png"', 'last'])
  assert.equal(terminal.clipboard.nativePastes, 0)
})

test('chat paste rejects insertion when bracketed paste is unavailable', async (t) => {
  t.mock.method(console, 'error', () => {})
  for (const unavailable of ['disabled', 'ignored']) {
    const terminals = new Terminals()
    const terminal = terminals.instances[0]
    if (unavailable === 'disabled')
      terminal.xterm.raw.modes.bracketedPasteMode = false
    if (unavailable === 'ignored')
      terminal.xterm.raw.options.ignoreBracketedPasteMode = true
    const group = new Group()
    group.resources.add(terminal.resource)
    const services = new Services(terminals)
    const paste = new ChatPaste(
      services,
      group,
      new Desktop(async () => ['first\nline', '"/image.png"']),
    )
    await setImmediate()
    await terminal.clipboard.paste()
    assert.deepEqual(terminal.texts, [])
    assert.equal(services.notifications.length, 1)
    paste.dispose()
  }
})

test('ownership requires the ADE group to remain locked and the terminal to remain in it, including after restoration', async () => {
  const group = { id: 5, isLocked: true }
  let terminalGroup = 5
  let stored: number | undefined = 5
  const services: WorkbenchServices = {
    get(id) {
      if (id === 'editorGroupsService')
        return {
          whenReady: Promise.resolve(),
          getGroup: (id: number) => (id === 5 ? group : undefined),
          onDidRemoveGroup: () => {},
        }
      if (id === 'storageService')
        return {
          getNumber: () => stored,
          remove: () => {
            stored = undefined
          },
        }
      if (id === 'editorService')
        return {
          findEditors: () => [{ groupId: terminalGroup }],
          onDidCloseEditor: () => {},
        }
      assert.fail(`Unexpected service ${id}`)
    },
    executeCommand: async () => {},
    registerCommand: () => ({ dispose() {} }),
  }
  const chats = await createChatTerminals(services)
  assert.equal(chats.owns({}), true)
  group.isLocked = false
  assert.equal(chats.owns({}), false)
  group.isLocked = true
  terminalGroup = 7
  assert.equal(chats.owns({}), false)
})
