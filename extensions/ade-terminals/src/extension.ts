import * as vscode from 'vscode'
import { TerminalLauncher, type TerminalKind } from './launcher.js'
import { ChatController } from './chats.js'
import { SidebarProvider } from './sidebar.js'
import type { Chat } from '../../../src/shared/chats.ts'

export function activate(context: vscode.ExtensionContext): void {
  const chats = new ChatController(context)
  const launcher = new TerminalLauncher()
  chats.coordinateFocus = (operation) => launcher.run(operation)
  const sidebar = new SidebarProvider(context, chats, launcher)
  context.subscriptions.push(
    chats,
    launcher,
    launcher.onDidChangeSelection((terminal) => chats.selectTerminal(terminal)),
    sidebar,
    vscode.window.registerWebviewViewProvider('adeTerminals.sidebar', sidebar),
    vscode.commands.registerCommand('adeTerminals.activateChat', (chat: Chat) =>
      chats.activateChat(chat).catch((error: unknown) => {
        void vscode.window.showErrorMessage(
          `ADE: ${error instanceof Error ? error.message : String(error)}`,
        )
      }),
    ),
    ...(['terminal', 'codex', 'claude'] as const).map((kind: TerminalKind) =>
      vscode.commands.registerCommand(`adeTerminals.${kind}`, () =>
        launcher.open(kind).catch((error: unknown) => {
          console.error('ADE terminal launch failed', error)
          void vscode.window.showErrorMessage(
            `ADE: ${error instanceof Error ? error.message : String(error)}`,
          )
        }),
      ),
    ),
  )
  // Terminals belong to the workspace session; deactivation must not kill them.
}
