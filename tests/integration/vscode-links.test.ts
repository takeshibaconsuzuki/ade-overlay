import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { simpleGit } from 'simple-git'
import { runDesktopClient, startIntegrationServer } from './harness'

test('VS Code opens web links in the desktop browser without navigating or creating windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-links-integration-'))
  const repo = join(directory, 'repo')
  await mkdir(repo)
  await simpleGit(repo).init()
  const extension = join(directory, 'extensions', 'ade-test.links-1.0.0')
  await mkdir(extension, { recursive: true })
  await writeFile(
    join(extension, 'package.json'),
    JSON.stringify({
      name: 'links',
      publisher: 'ade-test',
      version: '1.0.0',
      engines: { vscode: '^1.100.0' },
      main: './extension.js',
      activationEvents: ['*'],
      capabilities: { untrustedWorkspaces: { supported: true } },
    }),
  )
  await writeFile(
    join(extension, 'extension.js'),
    `const vscode = require('vscode');
exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('ade-test.openExternal', url => vscode.env.openExternal(vscode.Uri.parse(url))));
  context.subscriptions.push(vscode.commands.registerCommand('ade-test.editorLink', async (url, markdown = false) => {
    const document = await vscode.workspace.openTextDocument({ language: markdown ? 'markdown' : 'plaintext', content: markdown ? '[Open link](' + url + ')' : url });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 10, 0, 10);
    if (markdown) await vscode.commands.executeCommand('markdown.showPreview', document.uri);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('ade-test.terminalLink', url => {
    const output = new vscode.EventEmitter();
    const terminal = vscode.window.createTerminal({ name: 'Links', pty: { onDidWrite: output.event, open: () => output.fire(url + '\\r\\n'), close() {} } });
    context.subscriptions.push(output, terminal);
    terminal.show();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('ade-test.webviewLink', url => {
    const panel = vscode.window.createWebviewPanel('ade-test.links', 'Links', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = '<a href="' + url + '">Open link</a>';
    context.subscriptions.push(panel);
  }));
};`,
  )
  const server = await startIntegrationServer(directory, [repo])
  try {
    await runDesktopClient(
      'links',
      {
        ADE_SERVER_URL: `ws://127.0.0.1:${server.port}/rpc`,
        ADE_LINKS_DATA: directory,
      },
      120_000,
    )
  } finally {
    await server.close()
  }
})
