import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import {
  launchProviderSchema,
  sidebarActionSchema,
  type LaunchProvider,
  type SidebarState,
} from '../../../src/shared/sidebar.ts'
import type { ChatController } from './chats.js'
import type { TerminalLauncher } from './launcher.js'

export class SidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView
  private readonly subscription: vscode.Disposable
  private selectedProvider: LaunchProvider
  private actionVersion = 0
  private error?: string

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly chats: ChatController,
    private readonly launcher: TerminalLauncher,
  ) {
    this.selectedProvider =
      launchProviderSchema.safeParse(context.globalState.get('adeChatProvider'))
        .data ?? 'codex'
    this.subscription = chats.onDidChangeChats(() => this.publish())
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const assets = vscode.Uri.joinPath(this.context.extensionUri, 'out')
    view.webview.options = { enableScripts: true, localResourceRoots: [assets] }
    const script = view.webview.asWebviewUri(
      vscode.Uri.joinPath(assets, 'sidebar.js'),
    )
    const style = view.webview.asWebviewUri(
      vscode.Uri.joinPath(assets, 'sidebar.css'),
    )
    const nonce = randomBytes(16).toString('hex')
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${view.webview.cspSource};"><link rel="stylesheet" href="${style}"><title>ADE</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`
    const receiver = view.webview.onDidReceiveMessage((raw: unknown) => {
      const action = sidebarActionSchema.safeParse(raw).data
      if (!action || this.view !== view) return
      if (action.type === 'ready') {
        this.publish()
        return
      }
      if (action.type === 'select-provider') {
        this.selectedProvider = action.provider
        this.publish()
        void this.context.globalState
          .update('adeChatProvider', action.provider)
          .then(undefined, (error: unknown) =>
            console.error('ADE provider selection could not be saved', error),
          )
      }
      const version = ++this.actionVersion
      this.error = undefined
      this.publish()
      void (async () => {
        if (action.type === 'select-provider')
          await this.launcher.open(action.provider)
        else if (action.type === 'launch') await this.launcher.open(action.kind)
        else await this.chats.activateChat(action.chatId)
      })()
        .catch((error: unknown) => {
          if (version === this.actionVersion)
            this.error = error instanceof Error ? error.message : String(error)
        })
        .finally(() => {
          this.publish()
        })
    })
    view.onDidDispose(() => {
      receiver.dispose()
      if (this.view === view) this.view = undefined
    })
  }

  private publish(): void {
    const message: SidebarState = {
      type: 'state',
      chats: this.chats.getSnapshot().chats,
      selectedProvider: this.selectedProvider,
      activeChatId: this.chats.getActiveChatId(),
      error: this.error,
    }
    void this.view?.webview.postMessage(message)
  }

  dispose(): void {
    this.subscription.dispose()
    this.view = undefined
  }
}
