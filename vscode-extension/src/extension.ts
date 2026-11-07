import { randomBytes } from 'node:crypto'
import { relative } from 'node:path'
import * as vscode from 'vscode'
import type {
  Chat,
  ChatHistoryResults,
  ChatProviderInfo,
  ExtensionClientMethods,
  ServerMethods,
} from '../../src/shared/api'
import { DEFAULT_SERVER_URL } from '../../src/shared/constants'
import type { RunningWorktree } from '../../src/shared/editor-rpc'
import { connectRpc, type RpcClient } from '../../src/shared/rpc-client'
import type {
  ChatsMessage,
  HistoryMessage,
  WorktreesMessage,
} from '../shared/api'
import { ChatTerminals } from './chat-terminals'
import { connectDesktop } from './desktop'
import { registerDownload } from './download'
import { ClaudeTerminalProvider } from './providers/claude'
import { CodexTerminalProvider } from './providers/codex'

let desktop: ReturnType<typeof connectDesktop> | undefined
let client: RpcClient<ServerMethods, ExtensionClientMethods> | undefined

export function activate(context: vscode.ExtensionContext) {
  const terminalProviders = [
    new CodexTerminalProvider(),
    new ClaudeTerminalProvider(),
  ]
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
    terminalProviders,
  )
  const sidebar = new SidebarViewProvider(context.extensionUri, terminals)
  context.subscriptions.push(
    // Hidden views keep their page and continue to receive updates.
    vscode.window.registerWebviewViewProvider('ade.sidebar', sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    sidebar,
    terminals,
    registerDownload(),
  )
  desktop = connectDesktop({
    focusChatTerminal: (id) => terminals.focus(id),
    prepareChatPaste: (processId) => terminals.preparePaste(processId),
    worktreesChanged: (worktrees) => sidebar.setWorktrees(worktrees),
  })
  let providerRequest = 0
  client = connectRpc<ServerMethods, ExtensionClientMethods>(
    process.env.ADE_SERVER_URL ?? DEFAULT_SERVER_URL,
    {
      getClientInfo: () => ({
        kind: 'extension',
        name: 'ade-extension',
        version: context.extension.packageJSON.version,
      }),
      chatsChanged: (chats) => sidebar.setChats(chats),
      chatHistoryChanged: () => sidebar.searchHistory(),
    },
    {
      onStateChange: (state) => {
        const request = ++providerRequest
        sidebar.searchHistory()
        if (state !== 'connected') {
          sidebar.setChats(undefined)
          sidebar.setProviders([])
          return
        }
        void client!.rpc
          .getChatProviders()
          .then((providers) => {
            if (request !== providerRequest) return
            sidebar.setProviders(
              providers.filter((provider) =>
                terminalProviders.some(
                  (terminal) => terminal.id === provider.id,
                ),
              ),
            )
          })
          .catch((error: unknown) => {
            console.error('Unable to load chat providers', error)
          })
      },
    },
  )
}

class SidebarViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined
  private chats: Record<string, Chat> | undefined
  private providers: ChatProviderInfo[] = []
  // Selection survives sidebar reloads and temporary disconnects, but not extension restarts.
  private selectedProviderId: string | undefined
  private worktrees: RunningWorktree[] | undefined
  // The page's history query; undefined while its history tab is not shown.
  private historyQuery: string | undefined
  private historyRequest = 0
  private readonly terminalChanges: vscode.Disposable
  private readonly configurationChanges: vscode.Disposable

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly terminals: ChatTerminals,
  ) {
    this.terminalChanges = terminals.onDidChangeChatFocus(() =>
      this.sendSnapshot(),
    )
    this.configurationChanges = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('ade.sidebar.worktreeCount'))
          this.sendWorktrees()
      },
    )
  }

  setWorktrees(worktrees: RunningWorktree[]): void {
    this.worktrees = worktrees
    this.sendWorktrees()
  }

  private sendWorktrees(): void {
    const count =
      vscode.workspace
        .getConfiguration('ade.sidebar')
        .get<number>('worktreeCount') ?? 0
    const message: WorktreesMessage = {
      type: 'worktrees',
      // The VS Code server identifies this window's worktree as the desktop does.
      worktrees: this.worktrees
        ?.filter((worktree) => worktree.path !== process.env.ADE_WORKTREE_PATH)
        .slice(0, Math.max(0, count)),
    }
    void this.view?.webview.postMessage(message)
  }

  setChats(chats: Record<string, Chat> | undefined): void {
    this.chats = chats
    this.sendSnapshot()
  }

  setProviders(providers: ChatProviderInfo[]): void {
    this.providers = providers
    if (
      providers.length > 0 &&
      !providers.some((provider) => provider.id === this.selectedProviderId)
    )
      this.selectedProviderId = providers[0].id
    this.sendSnapshot()
  }

  private sendSnapshot(): void {
    const worktreePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const localChats = Object.entries(this.chats ?? {}).filter(
      ([, chat]) =>
        worktreePath !== undefined &&
        relative(worktreePath, chat.worktreePath) === '',
    )
    const selected =
      localChats.find(
        ([, chat]) =>
          chat.terminalId !== undefined &&
          chat.terminalId === this.terminals.lastFocusedTerminalId,
      ) ?? localChats[0]
    const message: ChatsMessage = {
      type: 'chats',
      chats: this.chats,
      providers: this.providers,
      selectedProviderId: this.selectedProviderId,
      selectedChatId: selected?.[0],
    }
    void this.view?.webview.postMessage(message)
  }

  // Sends results for the current history query; a later search supersedes earlier ones.
  searchHistory(): void {
    const request = ++this.historyRequest
    const query = this.historyQuery
    if (query === undefined) return
    const send = (results: ChatHistoryResults | undefined) => {
      if (request !== this.historyRequest) return
      const message: HistoryMessage = { type: 'history', query, results }
      void this.view?.webview.postMessage(message)
    }
    // Searches cover this window's repository, whose worktree the VS Code server identifies.
    const worktreePath = process.env.ADE_WORKTREE_PATH
    if (client?.state !== 'connected' || worktreePath === undefined) {
      send(undefined)
      return
    }
    client.rpc
      .searchChatHistory(worktreePath, query)
      .then(send, (error: unknown) => {
        console.error('Unable to search chat history', error)
        send(undefined)
      })
  }

  dispose(): void {
    this.terminalChanges.dispose()
    this.configurationChanges.dispose()
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    // Each page load reports ready and receives the latest snapshot.
    const messages = view.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') {
        // A new page starts without its history tab shown.
        this.historyQuery = undefined
        this.sendSnapshot()
        this.sendWorktrees()
      }
      if (
        message?.type === 'startChat' &&
        typeof message.providerId === 'string'
      )
        void this.startChat(message.providerId)
      if (message?.type === 'openChat' && typeof message.id === 'string')
        void this.openChat(message.id)
      if (
        message?.type === 'resumeChat' &&
        typeof message.providerId === 'string' &&
        typeof message.sessionId === 'string'
      )
        void this.resumeChat(message.providerId, message.sessionId)
      if (
        message?.type === 'searchHistory' &&
        (typeof message.query === 'string' || message.query === undefined)
      ) {
        this.historyQuery = message.query
        this.searchHistory()
      }
      if (message?.type === 'openTerminal') this.openTerminal()
      if (message?.type === 'openWorktree' && typeof message.path === 'string')
        void this.openWorktree(message.path)
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

  private async startChat(providerId: string): Promise<void> {
    try {
      if (!client) throw new Error('ADE server is not connected')
      const provider = this.providers.find(
        (provider) => provider.id === providerId,
      )
      if (!provider) throw new Error('The chat provider is unavailable')
      this.selectedProviderId = provider.id
      this.sendSnapshot()
      const command = await client.rpc.getChatCommand(provider.id)
      await this.terminals.start(provider.id, command)
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to start chat: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async resumeChat(
    providerId: string,
    sessionId: string,
  ): Promise<void> {
    const id = `${providerId}:${sessionId}`
    // A live session continues in its terminal rather than in a second process.
    if (this.chats?.[id]) return this.openChat(id)
    try {
      if (!client) throw new Error('ADE server is not connected')
      const provider = this.providers.find(
        (provider) => provider.id === providerId,
      )
      if (!provider) throw new Error('The chat provider is unavailable')
      const command = await client.rpc.getChatCommand(provider.id, sessionId)
      await this.terminals.start(provider.id, command)
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to resume chat: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private openTerminal(): void {
    // An editor opened without a target group avoids the locked chat terminal group.
    vscode.window
      .createTerminal({
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
        location: vscode.TerminalLocation.Editor,
      })
      .show()
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

  private async openWorktree(path: string): Promise<void> {
    try {
      if (!desktop) throw new Error('ADE desktop is not connected')
      await desktop.rpc.openWorktree(path)
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to open worktree: ${error instanceof Error ? error.message : String(error)}`,
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
