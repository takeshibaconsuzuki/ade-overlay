import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import pRetry from 'p-retry'
import { createMessageRpc } from '../../src/shared/message-rpc'
import {
  DESKTOP_RPC_COMMAND,
  EXTENSION_RPC_COMMAND,
  isExtensionMessage,
  type DesktopExtensionMethods,
  type ExtensionMethods,
} from '../../src/shared/editor-rpc'

export function connectDesktop(methods: ExtensionMethods) {
  const session = randomUUID()
  const controller = new AbortController()
  let connected = false
  let receive: (message: string) => void = () => {}
  const command = vscode.commands.registerCommand(
    EXTENSION_RPC_COMMAND,
    (call: unknown) => {
      if (!isExtensionMessage(call) || call.session !== session)
        throw new Error('Invalid desktop RPC session')
      if (call.type === 'message') receive(call.message)
    },
  )
  const ready = pRetry(
    async () => {
      await vscode.commands.executeCommand(DESKTOP_RPC_COMMAND, {
        type: 'connect',
        session,
      })
    },
    {
      retries: 40,
      minTimeout: 250,
      maxTimeout: 1000,
      signal: controller.signal,
    },
  ).then(() => {
    connected = true
  })
  // Activation can precede registration of the workbench command.
  void ready.catch(() => {})
  const rpc = createMessageRpc<DesktopExtensionMethods, ExtensionMethods>(
    {
      post: async (message) => {
        await ready
        controller.signal.throwIfAborted()
        await vscode.commands.executeCommand(DESKTOP_RPC_COMMAND, {
          type: 'message',
          session,
          message,
        })
      },
      on: (handler) => {
        receive = handler
      },
      off: () => {
        receive = () => {}
      },
    },
    methods,
  )
  return {
    get rpc() {
      if (!connected || controller.signal.aborted)
        throw new Error('ADE desktop is not connected')
      return rpc
    },
    async close() {
      controller.abort()
      rpc.$close(new Error('Extension closed'))
      command.dispose()
      await vscode.commands
        .executeCommand(DESKTOP_RPC_COMMAND, { type: 'disconnect', session })
        .then(undefined, () => {})
    },
  }
}
