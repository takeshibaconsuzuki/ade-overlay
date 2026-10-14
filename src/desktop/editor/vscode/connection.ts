import type { BirpcReturn } from 'birpc'
import { createMessageRpc } from '../../../shared/message-rpc'
import type {
  DesktopExtensionMethods,
  DesktopWorkbenchMethods,
  EditorMessage,
  ExtensionMethods,
  WorkbenchMethods,
} from '../../../shared/editor-rpc'

export interface EditorTransport {
  post(call: EditorMessage): void | Promise<void>
}

// One document owns one connection. Extension restarts replace only its extension peer.
export class EditorConnection {
  readonly workbench: BirpcReturn<WorkbenchMethods, DesktopWorkbenchMethods>
  extension: BirpcReturn<ExtensionMethods, DesktopExtensionMethods> | undefined
  private extensionSession: string | undefined
  private receiveWorkbench: (message: string) => void = () => {}
  private receiveExtension: (message: string) => void = () => {}
  private closed = false

  constructor(
    private readonly transport: EditorTransport,
    workbenchMethods: DesktopWorkbenchMethods,
    private readonly extensionMethods: DesktopExtensionMethods,
  ) {
    this.workbench = createMessageRpc<
      WorkbenchMethods,
      DesktopWorkbenchMethods
    >(
      {
        post: (message) => transport.post({ target: 'workbench', message }),
        on: (handler) => {
          this.receiveWorkbench = handler
        },
        off: () => {
          this.receiveWorkbench = () => {}
        },
      },
      workbenchMethods,
    )
  }

  receive(call: EditorMessage): void {
    if (this.closed) throw new Error('Editor RPC connection closed')
    if (call.target === 'workbench') this.receiveWorkbench(call.message)
    else {
      const message = call.call
      if (message.type === 'connect') {
        this.extension?.$close(new Error('Extension restarted'))
        const session = message.session
        this.extensionSession = session
        this.extension = createMessageRpc<
          ExtensionMethods,
          DesktopExtensionMethods
        >(
          {
            post: (message) =>
              this.transport.post({
                target: 'extension',
                call: { type: 'message', session, message },
              }),
            on: (handler) => {
              this.receiveExtension = handler
            },
            off: () => {
              this.receiveExtension = () => {}
            },
          },
          this.extensionMethods,
        )
      } else {
        if (message.session !== this.extensionSession)
          throw new Error('Extension RPC session expired')
        if (message.type === 'message') this.receiveExtension(message.message)
        else {
          this.extension?.$close(new Error('Extension disconnected'))
          this.extension = undefined
          this.extensionSession = undefined
        }
      }
    }
  }

  close(): void {
    this.closed = true
    const error = new Error('Editor RPC connection closed')
    this.workbench.$close(error)
    this.extension?.$close(error)
    this.extension = undefined
  }
}
