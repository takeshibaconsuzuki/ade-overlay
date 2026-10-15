import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createMessageRpc } from '../src/shared/message-rpc'
import type { TerminalPastePart } from '../src/shared/clipboard'
import { EditorConnection } from '../src/desktop/editor/vscode/connection'
import type {
  DesktopExtensionMethods,
  DesktopWorkbenchMethods,
  EditorMessage,
  ExtensionMethods,
  ExtensionMessage,
  WorkbenchMethods,
} from '../src/shared/editor-rpc'

function fixture(t: TestContext, name: string) {
  let receiveWorkbench: (message: string) => void = () => {}
  let receiveExtension: (call: ExtensionMessage) => void = () => {}
  const received: string[] = []
  const connection = new EditorConnection(
    {
      post(call: EditorMessage) {
        if (call.target === 'workbench') receiveWorkbench(call.message)
        else receiveExtension(call.call)
      },
    },
    {
      getDisabledExtensions: async () => [{ id: name }],
      settingsChanged: async (_generation, content) => {
        received.push(content)
      },
      ready() {},
      startupFailed() {},
      prepareChatPaste: async (pid): Promise<TerminalPastePart[] | undefined> =>
        connection.extension!.prepareChatPaste(pid),
    },
    {
      openChat: async (id) => {
        if (id === 'fail')
          throw new TypeError('Missing chat', { cause: new Error(name) })
        if (id === 'hold') await new Promise<void>(() => {})
        received.push(id)
      },
      openChatTerminal: async () => {},
      readClipboard: async () => [
        { type: 'text', data: new TextEncoder().encode(name) },
      ],
    },
  )
  const workbench = createMessageRpc<DesktopWorkbenchMethods, WorkbenchMethods>(
    {
      post: (message) => connection.receive({ target: 'workbench', message }),
      on: (handler) => {
        receiveWorkbench = handler
      },
      off: () => {
        receiveWorkbench = () => {}
      },
    },
    {
      applySettings: async (_content, generation) => {
        await workbench.settingsChanged(generation, name)
      },
      openChatTerminal: async () => {},
      persistSession: async () => {},
    },
  )
  function connectExtension(session: string) {
    connection.receive({
      target: 'extension',
      call: { type: 'connect', session },
    })
    const extension = createMessageRpc<
      DesktopExtensionMethods,
      ExtensionMethods
    >(
      {
        post: (message) =>
          connection.receive({
            target: 'extension',
            call: { type: 'message', session, message },
          }),
        on: (handler) => {
          receiveExtension = (call) => {
            if (call.type === 'message' && call.session === session)
              handler(call.message)
          }
        },
        off: () => {},
      },
      {
        focusChatTerminal: (id) => id === name,
        prepareChatPaste: async (
          pid,
        ): Promise<TerminalPastePart[] | undefined> => {
          if (pid === 0) return undefined
          const parts = await extension.readClipboard()
          return [
            { text: new TextDecoder().decode(parts![0].data) },
            {
              text: '"/image.png"',
              beforeDelay: 30,
              afterDelay: 70,
            },
          ]
        },
      },
    )
    t.after(() => extension.$close())
    return extension
  }
  t.after(() => {
    connection.close()
    workbench.$close()
  })
  return { connection, workbench, connectExtension, received }
}

test('two editor connections route bidirectional calls and nested replies independently', async (t) => {
  const a = fixture(t, 'a')
  const b = fixture(t, 'b')
  const extensionA = a.connectExtension('session-a')
  const extensionB = b.connectExtension('session-b')
  await Promise.all([
    extensionA.openChat('chat-a'),
    extensionB.openChat('chat-b'),
    a.connection.workbench.applySettings('settings', 1),
  ])
  assert.deepEqual(a.received, ['chat-a', 'a'])
  assert.deepEqual(b.received, ['chat-b'])
  assert.equal(await a.connection.extension!.focusChatTerminal('a'), true)
  assert.equal(await b.connection.extension!.focusChatTerminal('a'), false)
  assert.deepEqual(await b.workbench.getDisabledExtensions(), [{ id: 'b' }])
  assert.deepEqual(await a.workbench.prepareChatPaste(123), [
    { text: 'a' },
    { text: '"/image.png"', beforeDelay: 30, afterDelay: 70 },
  ])
  assert.deepEqual(await b.workbench.prepareChatPaste(123), [
    { text: 'b' },
    { text: '"/image.png"', beforeDelay: 30, afterDelay: 70 },
  ])
  assert.equal(await a.workbench.prepareChatPaste(0), undefined)
  await assert.rejects(extensionA.openChat('fail'), (error: unknown) => {
    assert.ok(error instanceof TypeError)
    assert.equal(error.message, 'Missing chat')
    assert.equal((error.cause as Error).message, 'a')
    return true
  })
  await assert.rejects(
    extensionA.$call('constructor' as 'openChat', ''),
    /not found/,
  )
})

test('extension restart rejects outstanding desktop calls and ignores old sessions', async (t) => {
  const f = fixture(t, 'editor')
  f.connectExtension('first')
  const old = f.connection.extension!
  const pending = assert.rejects(old.focusChatTerminal('editor'), /restarted/)
  f.connectExtension('second')
  await pending
  assert.throws(
    () =>
      f.connection.receive({
        target: 'extension',
        call: { type: 'message', session: 'first', message: '{}' },
      }),
    /expired/,
  )
  assert.equal(await f.connection.extension!.focusChatTerminal('editor'), true)
  // Replacing an extension does not invalidate the workbench connection.
  assert.deepEqual(await f.workbench.getDisabledExtensions(), [
    { id: 'editor' },
  ])
  f.connection.receive({
    target: 'extension',
    call: { type: 'disconnect', session: 'second' },
  })
  assert.equal(f.connection.extension, undefined)
})

test('document closure rejects pending calls and prevents delivery or replay', async (t) => {
  const f = fixture(t, 'editor')
  f.connectExtension('first')
  const extension = f.connection.extension!
  const pending = assert.rejects(
    extension.focusChatTerminal('editor'),
    /connection closed/,
  )
  f.connection.close()
  await pending
  await assert.rejects(f.connection.workbench.persistSession(), /closed/)
  assert.throws(
    () => f.connection.receive({ target: 'workbench', message: '{}' }),
    /closed/,
  )
})

test('malformed message closes its peer without an unhandled rejection', async () => {
  let receive: (message: string) => void = () => {}
  let stopped = false
  const rpc = createMessageRpc<{ wait(): void }, object>(
    {
      post() {},
      on(handler) {
        receive = handler
      },
      off() {
        stopped = true
      },
    },
    {},
  )
  const pending = assert.rejects(rpc.wait(), SyntaxError)
  receive('{invalid json')
  await pending
  await setImmediate()
  assert.equal(stopped, true)
})

test('a queued incoming call cannot run after its connection closes', async () => {
  let receive: (message: string) => void = () => {}
  let executions = 0
  const rpc = createMessageRpc<object, { run(): void }>(
    {
      post() {
        assert.fail('Closed peers must not send replies')
      },
      on(handler) {
        receive = handler
      },
      off() {},
    },
    {
      run() {
        executions++
      },
    },
  )
  const sender = createMessageRpc<{ run(): void }, object>(
    { post: (message) => receive(message), on() {}, off() {} },
    {},
  )
  const pending = assert.rejects(sender.run(), /closed/)
  rpc.$close()
  sender.$close()
  await pending
  await setImmediate()
  assert.equal(executions, 0)
})
