import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import type { DesktopExtensionMethods } from '../../src/shared/editor-rpc'
import type { TerminalChatProvider } from './terminal-chat-provider'
import { TerminalIdentities } from './terminal-identities'
import { WorkspaceTerminalIdentityStore } from './workspace-terminal-identity-store'

export class ChatTerminals {
  private readonly identities: TerminalIdentities
  private readonly subscriptions: vscode.Disposable[]

  constructor(
    state: vscode.Memento,
    private readonly desktop: Pick<DesktopExtensionMethods, 'openChatTerminal'>,
  ) {
    this.identities = new TerminalIdentities(
      new WorkspaceTerminalIdentityStore(state),
    )
    const remember = (terminal: vscode.Terminal) => {
      if (terminal.exitStatus !== undefined) return
      const id =
        'env' in terminal.creationOptions
          ? (terminal.creationOptions.env?.ADE_TERMINAL_ID ?? undefined)
          : undefined
      this.identities.track(terminal, id)
    }
    this.subscriptions = [
      vscode.window.onDidOpenTerminal(remember),
      vscode.window.onDidCloseTerminal((terminal) =>
        this.identities.forget(terminal),
      ),
    ]
    vscode.window.terminals.forEach(remember)
  }

  async start(provider: TerminalChatProvider): Promise<void> {
    const worktreePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!worktreePath) throw new Error('No worktree is open')
    await this.desktop.openChatTerminal({
      ...provider.getLaunchOptions(),
      worktreePath,
      terminalId: randomUUID(),
    })
  }

  focus(id: string): boolean {
    // A detached or background workbench cannot acknowledge focus for the selected page.
    return vscode.window.state.focused && this.identities.focus(id)
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose())
    this.identities.dispose()
  }
}
