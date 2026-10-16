import { dialog, shell, WebContentsView } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { EditorPage } from '../manager'
import type {
  ChatTerminalLaunch,
  ExtensionIdentifier,
} from '../../../shared/api'
import {
  EDITOR_RPC_CONNECT,
  EDITOR_RPC_MESSAGE,
  isEditorMessage,
  type DesktopExtensionMethods,
} from '../../../shared/editor-rpc'
import { EditorConnection } from './connection'
import type { TerminalPastePart } from '../../../shared/clipboard'
import {
  VscodeSettingsSync,
  type VscodeSettingsPage,
  type VscodeSettingsServer,
} from './vscode-settings-sync'

export class ElectronEditorPage implements EditorPage, VscodeSettingsPage {
  readonly view: WebContentsView
  readonly vscodeSettingsSync: VscodeSettingsSync
  private connection: EditorConnection | undefined
  private session: string | undefined
  private ready = false

  constructor(
    key: string,
    onFailure: (message: string) => void,
    vscodeSettingsServer: VscodeSettingsServer,
    readDisabledExtensions: () => Promise<ExtensionIdentifier[]>,
    desktop: DesktopExtensionMethods,
  ) {
    this.vscodeSettingsSync = new VscodeSettingsSync(this, vscodeSettingsServer)
    this.view = new WebContentsView({
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/vscode.cjs'),
        partition: `persist:vscode-${createHash('sha256').update(key).digest('hex')}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        focusOnNavigation: false,
      },
    })
    this.view.setBackgroundColor('#18181b')
    this.view.setVisible(false)
    this.view.webContents.on('render-process-gone', () => {
      this.disconnect()
      onFailure('The VS Code page closed unexpectedly. Retry to reopen it.')
    })
    this.view.webContents.on(
      'did-start-navigation',
      (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) {
          this.disconnect()
        }
      },
    )
    this.view.webContents.once('destroyed', () => this.disconnect())
    this.view.webContents.setWindowOpenHandler(({ url }) => {
      void this.openInBrowser(url)
      return { action: 'deny' }
    })
    this.view.webContents.ipc.handle(
      EDITOR_RPC_CONNECT,
      (event, session: unknown) => {
        if (
          event.senderFrame !== this.view.webContents.mainFrame ||
          typeof session !== 'string'
        )
          throw new Error('Invalid editor RPC sender')
        this.disconnect()
        this.session = session
        const connection = new EditorConnection(
          {
            post: (call) => {
              if (this.session !== session)
                throw new Error('Editor RPC session expired')
              this.view.webContents.send(EDITOR_RPC_MESSAGE, session, call)
            },
          },
          {
            getDisabledExtensions: readDisabledExtensions,
            prepareChatPaste: async (
              processId,
            ): Promise<TerminalPastePart[] | undefined> => {
              if (!connection.extension)
                throw new Error('The chat extension is not ready')
              return connection.extension.prepareChatPaste(processId)
            },
            settingsChanged: (generation, content) =>
              this.vscodeSettingsSync.changed(generation, content),
            ready: () => {
              if (this.connection !== connection) return
              this.ready = true
              this.vscodeSettingsSync.start()
            },
            startupFailed: (message) => {
              if (this.connection !== connection) return
              this.ready = false
              this.vscodeSettingsSync.stop()
              onFailure(message)
            },
          },
          desktop,
        )
        this.connection = connection
      },
    )
    this.view.webContents.ipc.handle(
      EDITOR_RPC_MESSAGE,
      (event, session: unknown, call: unknown) => {
        if (
          event.senderFrame !== this.view.webContents.mainFrame ||
          session !== this.session ||
          !isEditorMessage(call) ||
          !this.connection
        )
          throw new Error('Invalid editor RPC session')
        this.connection.receive(call)
      },
    )
  }

  private async openInBrowser(url: string): Promise<void> {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return
    try {
      await shell.openExternal(target.href)
    } catch {
      dialog.showErrorBox(
        'Unable to open link',
        'The link could not be opened in your default browser. Check your browser settings and try again.',
      )
    }
  }

  private disconnect(): void {
    this.ready = false
    this.session = undefined
    this.vscodeSettingsSync.stop()
    this.connection?.close()
    this.connection = undefined
  }

  async load(url: string): Promise<void> {
    const origin = new URL(url).origin
    this.view.webContents.on('will-navigate', (event, next) => {
      if (new URL(next).origin !== origin) event.preventDefault()
    })
    let status = 0
    const onNavigate = (_event: Electron.Event, _url: string, code: number) => {
      status = code
    }
    this.view.webContents.on('did-navigate', onNavigate)
    try {
      await this.view.webContents.loadURL(url)
      if (status >= 400) throw new Error('VS Code page request failed')
    } finally {
      if (!this.view.webContents.isDestroyed())
        this.view.webContents.off('did-navigate', onNavigate)
    }
  }

  async openChatTerminal(options: ChatTerminalLaunch): Promise<void> {
    if (!this.ready || !this.connection)
      throw new Error('The workbench is not ready')
    await this.connection.workbench.openChatTerminal(options)
  }

  async focusChatTerminal(id: string): Promise<boolean> {
    if (!this.ready || !this.connection?.extension) return false
    return this.connection.extension.focusChatTerminal(id)
  }

  dispose(): void {
    this.disconnect()
    this.vscodeSettingsSync.dispose()
    if (!this.view.webContents.isDestroyed())
      this.view.webContents.close({ waitForBeforeUnload: false })
  }

  async applySettings(content: string, generation: number): Promise<void> {
    if (!this.ready || !this.connection)
      throw new Error('The workbench is not ready')
    await this.connection.workbench.applySettings(content, generation)
  }

  async prepareForDisconnect(): Promise<void> {
    if (!this.ready || !this.connection) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.connection.workbench.persistSession(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Timed out saving VS Code session')),
            5000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
