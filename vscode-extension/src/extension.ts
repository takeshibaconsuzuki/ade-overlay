import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'ade.sidebar',
      new SidebarViewProvider(context.extensionUri),
    ),
  )
}

class SidebarViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView) {
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
}
