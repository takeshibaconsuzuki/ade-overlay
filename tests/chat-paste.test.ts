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
import type { TerminalPastePart } from '../src/shared/clipboard'

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
  inputs: { data: string; user?: boolean; binary?: boolean }[] = []
  events: string[] = []
  xterm = {
    raw: {
      modes: { bracketedPasteMode: true },
      options: { ignoreBracketedPasteMode: false },
      paste: (text: string) => {
        this.texts.push(text)
        this.xterm.raw._core.coreService.triggerDataEvent(`paste:${text}`, true)
      },
      _core: {
        coreService: {
          triggerDataEvent: (data: string, user = false) => {
            this.inputs.push({ data, user })
            this.events.push(data)
          },
          triggerBinaryEvent: (data: string) => {
            this.inputs.push({ data, binary: true })
            this.events.push(data)
          },
        },
      },
    },
  }
  async sendText(data: string) {
    this.events.push(data)
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

function textParts(...texts: string[]): TerminalPastePart[] {
  return texts.map((text) => ({ text }))
}

const PASTE_DELAY_MS = 50
const imagePart: TerminalPastePart = {
  text: '"/image.png"',
  beforeDelay: PASTE_DELAY_MS,
  afterDelay: PASTE_DELAY_MS,
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
  let text = textParts('converted')
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
  const conversion = deferred<TerminalPastePart[]>()
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
  conversion.resolve(textParts('prepared chat content'))
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
    const prepared = deferred<TerminalPastePart[]>()
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
    prepared.resolve(textParts('must not paste'))
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
  const conversions = [
    deferred<TerminalPastePart[]>(),
    deferred<TerminalPastePart[]>(),
  ]
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
  conversions[1].resolve(textParts('second'))
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
  const conversion = deferred<TerminalPastePart[]>()
  let copied = 'initial'
  let calls = 0
  const paste = new ChatPaste(
    services,
    group,
    new Desktop(async () => {
      const text = copied
      if (calls++ === 0) return conversion.promise
      return textParts(text)
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
  conversion.resolve([...textParts('before'), imagePart, ...textParts('after')])
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
    new Desktop(async () => [
      ...textParts('before'),
      imagePart,
      ...textParts('after'),
    ]),
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

test('parts with omitted or zero delays paste synchronously', async (t) => {
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const paste = new ChatPaste(
    new Services(terminals),
    group,
    new Desktop(async () => [
      ...textParts('first\nline', '"/image.png"'),
      { text: '"/unpaced.png"' },
      { text: '"/zero.png"', beforeDelay: 0, afterDelay: 0 },
      ...textParts('last'),
    ]),
  )
  t.after(() => paste.dispose())
  t.mock.method(terminal.xterm.raw, 'paste', (text: string) => {
    terminal.texts.push(text)
    // A microtask must not run between parts of one insertion.
    queueMicrotask(() => group.resources.clear())
  })
  await setImmediate()
  await terminal.clipboard.paste()
  assert.deepEqual(terminal.texts, [
    'first\nline',
    '"/image.png"',
    '"/unpaced.png"',
    '"/zero.png"',
    'last',
  ])
  assert.equal(terminal.clipboard.nativePastes, 0)
})

test('provider delays apply independently and hold subsequent paste requests in the queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  let calls = 0
  const part: TerminalPastePart = {
    text: 'paced',
    beforeDelay: 30,
    afterDelay: 70,
  }
  const paste = new ChatPaste(
    new Services(terminals),
    group,
    new Desktop(async () => (calls++ === 0 ? [part] : textParts('next'))),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  const first = terminal.clipboard.paste()
  const second = terminal.clipboard.paste()
  await setImmediate()
  assert.equal(calls, 2)
  assert.deepEqual(terminal.texts, [])
  t.mock.timers.tick(29)
  await setImmediate()
  assert.deepEqual(terminal.texts, [])
  t.mock.timers.tick(1)
  await setImmediate()
  assert.deepEqual(terminal.texts, [part.text])
  t.mock.timers.tick(69)
  await setImmediate()
  assert.deepEqual(terminal.texts, [part.text])
  t.mock.timers.tick(1)
  await Promise.all([first, second])
  assert.deepEqual(terminal.texts, [part.text, 'next'])
})

test('consecutive images retain isolation and source order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const secondImage = { ...imagePart, text: '"/second.png"' }
  const paste = new ChatPaste(
    new Services(terminals),
    group,
    new Desktop(async () => [imagePart, secondImage]),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  const pending = terminal.clipboard.paste()
  await setImmediate()
  t.mock.timers.tick(PASTE_DELAY_MS)
  await setImmediate()
  assert.deepEqual(terminal.texts, [imagePart.text])
  t.mock.timers.tick(PASTE_DELAY_MS)
  await setImmediate()
  assert.deepEqual(terminal.texts, [imagePart.text])
  t.mock.timers.tick(PASTE_DELAY_MS)
  await setImmediate()
  assert.deepEqual(terminal.texts, [imagePart.text, secondImage.text])
  t.mock.timers.tick(PASTE_DELAY_MS)
  await pending
})

test('typing, sendText shortcuts, Enter and binary input share one ordered queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const paste = new ChatPaste(
    new Services(terminals),
    group,
    new Desktop(async () => [
      ...textParts('before'),
      imagePart,
      ...textParts('after'),
    ]),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  const pending = terminal.clipboard.paste()
  await setImmediate()
  const core = terminal.xterm.raw._core.coreService
  core.triggerDataEvent('typed', true)
  const shortcut = terminal.sendText('\x17')
  core.triggerDataEvent('\r', true)
  core.triggerBinaryEvent('binary')
  assert.deepEqual(terminal.events, ['paste:before'])
  core.triggerDataEvent('protocol reply')
  assert.deepEqual(terminal.events, ['paste:before', 'protocol reply'])
  t.mock.timers.tick(PASTE_DELAY_MS)
  await setImmediate()
  core.triggerDataEvent('tail', true)
  t.mock.timers.tick(PASTE_DELAY_MS - 1)
  await setImmediate()
  assert.deepEqual(terminal.events, [
    'paste:before',
    'protocol reply',
    `paste:${imagePart.text}`,
  ])
  t.mock.timers.tick(1)
  await Promise.all([pending, shortcut])
  await setImmediate()
  assert.deepEqual(terminal.events, [
    'paste:before',
    'protocol reply',
    `paste:${imagePart.text}`,
    'paste:after',
    'typed',
    '\x17',
    '\r',
    'binary',
    'tail',
  ])
  assert.deepEqual(terminal.inputs.slice(-4), [
    { data: 'typed', user: true },
    { data: '\r', user: true },
    { data: 'binary', binary: true },
    { data: 'tail', user: true },
  ])
})

test('queued keyboard input and later clipboard requests retain their arrival order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  let calls = 0
  const paste = new ChatPaste(
    new Services(terminals),
    group,
    new Desktop(async () => (calls++ === 0 ? [imagePart] : textParts('next'))),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  const first = terminal.clipboard.paste()
  await setImmediate()
  const core = terminal.xterm.raw._core.coreService
  core.triggerDataEvent('typed', true)
  const second = terminal.clipboard.paste()
  core.triggerDataEvent('\r', true)
  t.mock.timers.tick(PASTE_DELAY_MS)
  await setImmediate()
  t.mock.timers.tick(PASTE_DELAY_MS)
  await Promise.all([first, second])
  await setImmediate()
  assert.deepEqual(terminal.events, [
    `paste:${imagePart.text}`,
    'typed',
    'paste:next',
    '\r',
  ])
})

test('input stays ordered while an overlapping paste is still preparing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const preparation = deferred<TerminalPastePart[]>()
  let calls = 0
  const paste = new ChatPaste(
    new Services(terminals),
    group,
    new Desktop(async () =>
      calls++ === 0 ? [imagePart] : preparation.promise,
    ),
  )
  t.after(() => paste.dispose())
  await setImmediate()
  const first = terminal.clipboard.paste()
  await setImmediate()
  const second = terminal.clipboard.paste()
  const core = terminal.xterm.raw._core.coreService
  core.triggerDataEvent('first key', true)
  t.mock.timers.tick(PASTE_DELAY_MS)
  await setImmediate()
  t.mock.timers.tick(PASTE_DELAY_MS)
  await first
  await setImmediate()
  core.triggerDataEvent('second key', true)
  core.triggerBinaryEvent('binary')
  core.triggerDataEvent('\r', true)
  assert.deepEqual(terminal.events, [`paste:${imagePart.text}`])
  preparation.resolve(textParts('second paste'))
  await second
  await setImmediate()
  assert.deepEqual(terminal.events, [
    `paste:${imagePart.text}`,
    'paste:second paste',
    'first key',
    'second key',
    'binary',
    '\r',
  ])
  core.triggerDataEvent('after drain', true)
  assert.equal(terminal.events.at(-1), 'after drain')
})

test('deferred input follows the preceding queued paste outcome', async (t) => {
  for (const failure of ['preparation', 'insertion', 'validation']) {
    await t.test(failure, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      t.mock.method(console, 'error', () => {})
      const terminals = new Terminals()
      const terminal = terminals.instances[0]
      const group = new Group()
      group.resources.add(terminal.resource)
      const services = new Services(terminals)
      const preparation = deferred<TerminalPastePart[]>()
      let calls = 0
      const paste = new ChatPaste(
        services,
        group,
        new Desktop(async () =>
          calls++ === 0 ? [imagePart] : preparation.promise,
        ),
      )
      t.after(() => paste.dispose())
      const original = terminal.xterm.raw.paste
      t.mock.method(terminal.xterm.raw, 'paste', (text: string) => {
        if (failure === 'insertion' && text === 'second paste')
          throw new Error('insertion failed')
        original(text)
      })
      await setImmediate()
      const first = terminal.clipboard.paste()
      await setImmediate()
      const core = terminal.xterm.raw._core.coreService
      core.triggerDataEvent('before second paste', true)
      const second = terminal.clipboard.paste()
      core.triggerDataEvent('after second paste', true)
      const shortcut = terminal.sendText('\x17')
      core.triggerBinaryEvent('must not replay')
      core.triggerDataEvent('\r', true)
      if (failure === 'preparation')
        preparation.reject(new Error('preparation failed'))
      t.mock.timers.tick(PASTE_DELAY_MS)
      await setImmediate()
      t.mock.timers.tick(PASTE_DELAY_MS)
      await first
      if (failure === 'validation')
        terminal.xterm.raw.modes.bracketedPasteMode = false
      if (failure !== 'preparation')
        preparation.resolve(textParts('second paste'))
      await Promise.all([second, shortcut])
      await setImmediate()
      assert.deepEqual(terminal.events, [
        `paste:${imagePart.text}`,
        'before second paste',
      ])
      assert.equal(services.notifications.length, 1)
      terminal.xterm.raw.modes.bracketedPasteMode = true
      core.triggerDataEvent('new input', true)
      assert.equal(terminal.events.at(-1), 'new input')
    })
  }
})

test('failed insertion drops deferred input and releases subsequent keyboard input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'error', () => {})
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const group = new Group()
  group.resources.add(terminal.resource)
  const services = new Services(terminals)
  const paste = new ChatPaste(
    services,
    group,
    new Desktop(async () => [imagePart]),
  )
  t.after(() => paste.dispose())
  t.mock.method(terminal.xterm.raw, 'paste', () => {
    throw new Error('paste failed')
  })
  await setImmediate()
  const pending = terminal.clipboard.paste()
  await setImmediate()
  const core = terminal.xterm.raw._core.coreService
  core.triggerDataEvent('must not submit\r', true)
  t.mock.timers.tick(PASTE_DELAY_MS)
  await pending
  await setImmediate()
  assert.deepEqual(terminal.events, [])
  assert.equal(services.notifications.length, 1)
  core.triggerDataEvent('new input', true)
  assert.deepEqual(terminal.events, ['new input'])
})

test('disposing the integration restores terminal input handlers', async () => {
  const terminals = new Terminals()
  const terminal = terminals.instances[0]
  const core = terminal.xterm.raw._core.coreService
  const data = core.triggerDataEvent
  const binary = core.triggerBinaryEvent
  const sendText = terminal.sendText
  const clipboard = terminal.clipboard.paste
  const paste = new ChatPaste(
    new Services(terminals),
    new Group(),
    new Desktop(async () => []),
  )
  await setImmediate()
  assert.notEqual(core.triggerDataEvent, data)
  assert.notEqual(core.triggerBinaryEvent, binary)
  assert.notEqual(terminal.sendText, sendText)
  paste.dispose()
  assert.equal(core.triggerDataEvent, data)
  assert.equal(core.triggerBinaryEvent, binary)
  assert.equal(terminal.sendText, sendText)
  assert.equal(terminal.clipboard.paste, clipboard)
})

test('terminal changes during either image delay cancel the remaining content', async (t) => {
  for (const phase of ['before', 'after']) {
    for (const reason of [
      'move',
      'close',
      'disconnect',
      'removed',
      'process',
      'bracketed',
    ]) {
      await t.test(`${reason} ${phase} image`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        t.mock.method(console, 'error', () => {})
        const terminals = new Terminals()
        const terminal = terminals.instances[0]
        const group = new Group()
        group.resources.add(terminal.resource)
        const services = new Services(terminals)
        const paste = new ChatPaste(
          services,
          group,
          new Desktop(async () => [
            ...textParts('before'),
            imagePart,
            ...textParts('after'),
          ]),
        )
        t.after(() => paste.dispose())
        await setImmediate()
        const pending = terminal.clipboard.paste()
        await setImmediate()
        if (phase === 'after') {
          t.mock.timers.tick(PASTE_DELAY_MS)
          await setImmediate()
        }
        const core = terminal.xterm.raw._core.coreService
        core.triggerDataEvent('must not submit\r', true)
        core.triggerBinaryEvent('must not replay')
        if (reason === 'move') group.resources.clear()
        if (reason === 'close') terminal.isDisposed = true
        if (reason === 'disconnect') paste.dispose()
        if (reason === 'removed') terminals.removed(terminal)
        if (reason === 'process') terminal.processId++
        if (reason === 'bracketed')
          terminal.xterm.raw.modes.bracketedPasteMode = false
        t.mock.timers.tick(PASTE_DELAY_MS)
        await pending
        await setImmediate()
        assert.deepEqual(
          terminal.texts,
          phase === 'before' ? ['before'] : ['before', imagePart.text],
        )
        assert.equal(services.notifications.length, 1)
        assert.ok(!terminal.events.includes('must not submit\r'))
        assert.ok(!terminal.events.includes('must not replay'))
      })
    }
  }
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
      new Desktop(async () => [...textParts('first\nline'), imagePart]),
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
