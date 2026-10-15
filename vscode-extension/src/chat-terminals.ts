import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import type { DesktopExtensionMethods } from '../../src/shared/editor-rpc'
import type { TerminalChatProvider } from './terminal-chat-provider'
import { TerminalIdentities } from './terminal-identities'
import { WorkspaceTerminalIdentityStore } from './workspace-terminal-identity-store'
import { TemporaryImageFileWriter } from './image-file-writer'

export class ChatTerminals {
  private readonly identities: TerminalIdentities
  private readonly subscriptions: vscode.Disposable[]
  private readonly imageFileWriters = new Map<
    string,
    TemporaryImageFileWriter
  >()
  private readonly providers: ReadonlyMap<string, TerminalChatProvider>

  constructor(
    state: vscode.Memento,
    private readonly desktop: DesktopExtensionMethods,
    providers: readonly TerminalChatProvider[],
  ) {
    this.providers = new Map(
      providers.map((provider) => [provider.id, provider]),
    )
    this.identities = new TerminalIdentities(
      new WorkspaceTerminalIdentityStore(state),
    )
    const remember = (terminal: vscode.Terminal) => {
      if (terminal.exitStatus !== undefined) return
      const id =
        'env' in terminal.creationOptions
          ? (terminal.creationOptions.env?.ADE_TERMINAL_ID ?? undefined)
          : undefined
      const providerId =
        'env' in terminal.creationOptions
          ? terminal.creationOptions.env?.ADE_TERMINAL_PROVIDER
          : undefined
      this.identities.track(
        terminal,
        id && providerId ? { id, providerId } : undefined,
      )
    }
    this.subscriptions = [
      vscode.window.onDidOpenTerminal(remember),
      vscode.window.onDidCloseTerminal((terminal) => {
        const identity = this.identities.get(terminal)
        this.identities.forget(terminal)
        if (identity) {
          const imageFileWriter =
            this.imageFileWriters.get(identity.id) ??
            new TemporaryImageFileWriter(identity.id)
          this.imageFileWriters.delete(identity.id)
          void imageFileWriter
            .dispose()
            .catch(() => console.error('Unable to remove chat paste images'))
        }
      }),
    ]
    vscode.window.terminals.forEach(remember)
  }

  async start(providerId: string): Promise<void> {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error('The chat terminal provider is unavailable')
    const worktreePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!worktreePath) throw new Error('No worktree is open')
    await this.desktop.openChatTerminal({
      ...provider.getLaunchOptions(),
      worktreePath,
      terminalId: randomUUID(),
      providerId: provider.id,
    })
  }

  focus(id: string): boolean {
    // A detached or background workbench cannot acknowledge focus for the selected page.
    return vscode.window.state.focused && this.identities.focus(id)
  }

  async preparePaste(processId: number): Promise<string[] | undefined> {
    const identity = this.identities.forProcess(processId)
    if (!identity) return undefined
    const provider = this.providers.get(identity.providerId)
    if (!provider) throw new Error('The chat terminal provider is unavailable')
    const parts = await this.desktop.readClipboard()
    if (this.identities.forProcess(processId) !== identity)
      throw new Error('Chat terminal closed during paste')
    let imageFileWriter = this.imageFileWriters.get(identity.id)
    if (!imageFileWriter) {
      imageFileWriter = new TemporaryImageFileWriter(identity.id)
      this.imageFileWriters.set(identity.id, imageFileWriter)
    }
    const pastes = await provider.convertClipboard(parts, imageFileWriter)
    if (this.identities.forProcess(processId) !== identity)
      throw new Error('Chat terminal closed during paste')
    return pastes
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose())
    this.identities.dispose()
  }
}
