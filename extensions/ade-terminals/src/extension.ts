import * as vscode from 'vscode'
import { TerminalLauncher, type TerminalKind } from './launcher.js'

export function activate(context: vscode.ExtensionContext): void {
  const launcher = new TerminalLauncher()
  // Native welcome-view command links render as buttons, without a webview.
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('adeTerminals.launcher', {
      getChildren: () => [],
      getTreeItem: (item: vscode.TreeItem) => item,
    }),
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
