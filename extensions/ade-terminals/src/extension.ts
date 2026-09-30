import * as vscode from 'vscode'
import { TerminalLauncher } from './launcher.js'
import { ChatController } from './chats.js'
import { TerminalIdentities } from './terminal-identities.js'
import { SidebarProvider } from './sidebar.js'
import { launchKindSchema } from '../../../src/shared/sidebar.ts'

export function activate(context: vscode.ExtensionContext): void {
  const identities = new TerminalIdentities(context.workspaceState)
  const launcher = new TerminalLauncher(identities)
  const chats = new ChatController(identities, (operation) =>
    launcher.run(operation),
  )
  const sidebar = new SidebarProvider(context, chats, launcher)
  context.subscriptions.push(
    chats,
    launcher,
    identities,
    launcher.onDidChangeSelection((terminal) => chats.selectTerminal(terminal)),
    sidebar,
    vscode.window.registerWebviewViewProvider('adeTerminals.sidebar', sidebar),
    ...launchKindSchema.options.map((kind) =>
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
