import type { BirpcReturn } from 'birpc'
import { createMessageRpc } from '../shared/message-rpc'
import {
  DESKTOP_RPC_COMMAND,
  EXTENSION_RPC_COMMAND,
  isExtensionMessage,
  type DesktopBridge,
  type DesktopWorkbenchMethods,
  type WorkbenchMethods,
} from '../shared/editor-rpc'
import { createChatTerminals } from './chat-terminals'
import { createSettings } from './settings'
import { persistVscodeSession } from './session'
import type { ProfileStorage, WorkbenchServices } from './services'

class WorkbenchConnection {
  readonly desktop: BirpcReturn<DesktopWorkbenchMethods, WorkbenchMethods>
  private services: WorkbenchServices | undefined
  private terminals: Awaited<ReturnType<typeof createChatTerminals>> | undefined
  private settings: ReturnType<typeof createSettings> | undefined
  private extensionSession: string | undefined

  constructor(bridge: DesktopBridge) {
    let receive: (message: string) => void = () => {}
    const connected = bridge.setHandleCall((call) => {
      if (call.target === 'workbench') receive(call.message)
      else if (call.call.session === this.extensionSession) {
        void this.services
          ?.executeCommand(EXTENSION_RPC_COMMAND, call.call)
          .catch((error: unknown) =>
            console.error('Extension RPC delivery failed', error),
          )
      }
    })
    this.desktop = createMessageRpc<DesktopWorkbenchMethods, WorkbenchMethods>(
      {
        post: async (message) => {
          await connected
          if (this.desktop.$closed) throw new Error('Workbench closed')
          await bridge.post({ target: 'workbench', message })
        },
        on: (handler) => {
          receive = handler
        },
        off: () => {
          receive = () => {}
        },
      },
      {
        openChatTerminal: async (options) => {
          if (!this.terminals) throw new Error('The workbench is not ready')
          await this.terminals.open(options)
        },
        applySettings: async (content, generation) => {
          if (!this.settings) throw new Error('The workbench is not ready')
          await this.settings.apply(content, generation)
        },
        persistSession: async () => {
          if (this.services) await persistVscodeSession(this.services)
        },
      },
    )
    this.forwardExtension = async (call) => {
      if (!isExtensionMessage(call))
        throw new Error('Invalid extension RPC message')
      await connected
      if (call.type === 'connect') this.extensionSession = call.session
      if (call.session !== this.extensionSession)
        throw new Error('Extension RPC session expired')
      await bridge.post({ target: 'extension', call })
      if (call.type === 'disconnect') this.extensionSession = undefined
    }
    window.addEventListener(
      'pagehide',
      () => this.desktop.$close(new Error('Workbench closed')),
      { once: true },
    )
  }

  private readonly forwardExtension: (call: unknown) => Promise<void>

  async initializeExtensions(storage: ProfileStorage): Promise<void> {
    try {
      const disabled = await this.desktop.getDisabledExtensions()
      const key = 'extensionsIdentifiers/disabled'
      if (disabled.length) storage.store(key, JSON.stringify(disabled), 0, 1)
      else storage.remove(key, 0)
      await storage.flush()
    } catch (error) {
      await this.desktop.startupFailed(
        'Unable to load host extension enablement. Restore access to the host profile and retry.',
      )
      throw error
    }
  }

  attach(services: WorkbenchServices): Promise<void> {
    this.services = services
    const command = services.registerCommand(
      DESKTOP_RPC_COMMAND,
      this.forwardExtension,
    )
    window.addEventListener('pagehide', () => command.dispose(), { once: true })
    return (async () => {
      this.terminals = await createChatTerminals(services)
      this.settings = createSettings(services, (generation, content) => {
        void this.desktop
          .settingsChanged(generation, content)
          .catch((error: unknown) =>
            console.error('Unable to send settings to desktop', error),
          )
      })
      await this.desktop.ready()
    })().catch((error: unknown) => {
      console.error('Unable to initialize ADE workbench', error)
      void this.desktop
        .startupFailed(
          'Unable to initialize the workbench. Retry to reopen it.',
        )
        .catch(() => {})
    })
  }
}

let connection: WorkbenchConnection | undefined

// Called by the pinned patch before workbench creation. Service references remain module-private.
export function initializeExtensions(storage: ProfileStorage): Promise<void> {
  const bridge = (globalThis as unknown as { adeDesktop: DesktopBridge })
    .adeDesktop
  connection = new WorkbenchConnection(bridge)
  return connection.initializeExtensions(storage)
}

export function attachWorkbench(services: WorkbenchServices): Promise<void> {
  if (!connection) throw new Error('ADE workbench was not initialized')
  return connection.attach(services)
}
