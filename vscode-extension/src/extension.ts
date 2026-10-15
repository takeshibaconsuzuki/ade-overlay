import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import type {
  Chat,
  ExtensionClientMethods,
  ServerMethods,
} from '../../src/shared/api'
import { DEFAULT_SERVER_URL } from '../../src/shared/constants'
import { connectRpc, type RpcClient } from '../../src/shared/rpc-client'
import type { ChatsMessage } from '../shared/api'
import { ChatTerminals } from './chat-terminals'
import { connectDesktop } from './desktop'
import { CodexTerminalProvider } from './providers/codex'

let desktop: ReturnType<typeof connectDesktop> | undefined
let client: RpcClient<ServerMethods, ExtensionClientMethods> | undefined

export function activate(context: vscode.ExtensionContext) {
  const terminals = new ChatTerminals(
    context.workspaceState,
    {
      openChat: async (id) => {
        if (!desktop) throw new Error('ADE desktop is not connected')
        await desktop.rpc.openChat(id)
      },
      openChatTerminal: async (options) => {
        if (!desktop) throw new Error('ADE desktop is not connected')
        await desktop.rpc.openChatTerminal(options)
      },
      readClipboard: async () => {
        if (!desktop) throw new Error('ADE desktop is not connected')
        return desktop.rpc.readClipboard()
      },
    },
    [new CodexTerminalProvider()],
  )
  const sidebar = new SidebarViewProvider(context.extensionUri, terminals)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ade.sidebar', sidebar),
    sidebar,
    terminals,
  )
  desktop = connectDesktop({
    focusChatTerminal: (id) => terminals.focus(id),
    prepareChatPaste: (processId) => terminals.preparePaste(processId),
  })
  client = connectRpc<ServerMethods, ExtensionClientMethods>(
    process.env.ADE_SERVER_URL ?? DEFAULT_SERVER_URL,
    {
      getClientInfo: () => ({
        kind: 'extension',
        name: 'ade-extension',
        version: context.extension.packageJSON.version,
      }),
      chatsChanged: (chats) => sidebar.setChats(chats),
    },
    {
      onStateChange: (state) => {
        if (state !== 'connected') sidebar.setChats(undefined)
      },
    },
  )
}

class SidebarViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined
  private chats: Record<string, Chat> | undefined
  private readonly terminalChanges: vscode.Disposable

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly terminals: ChatTerminals,
  ) {
    this.terminalChanges = terminals.onDidChangeActiveTerminal(() =>
      this.sendSnapshot(),
    )
  }

  setChats(chats: Record<string, Chat> | undefined): void {
    this.chats = chats
    this.sendSnapshot()
  }

  private sendSnapshot(): void {
    const message: ChatsMessage = {
      type: 'chats',
      chats: this.chats,
      activeTerminalId: this.terminals.activeTerminalId,
    }
    void this.view?.webview.postMessage(message)
  }

  dispose(): void {
    this.terminalChanges.dispose()
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    // Webview scripts restart after being hidden; each ready message gets the latest snapshot.
    const messages = view.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') this.sendSnapshot()
      if (message?.type === 'startCodex') void this.startCodex()
      if (message?.type === 'openChat' && typeof message.id === 'string')
        void this.openChat(message.id)
    })
    view.onDidDispose(() => {
      messages.dispose()
      if (this.view === view) this.view = undefined
    })
    const assets = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview')
    const { webview } = view
    webview.options = {
      enableScripts: true,
      localResourceRoots: [assets],
    }

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(assets, 'index.js'),
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(assets, 'index.css'),
    )
    const nonce = randomBytes(16).toString('hex')

    webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>ADE</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`
  }

  private async startCodex(): Promise<void> {
    try {
      await this.terminals.start('codex')
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to start Codex: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async openChat(id: string): Promise<void> {
    try {
      if (!desktop) throw new Error('ADE desktop is not connected')
      await desktop.rpc.openChat(id)
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to open chat: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

export async function deactivate(): Promise<void> {
  await desktop?.close()
  desktop = undefined
  await client?.close()
  client = undefined
}
