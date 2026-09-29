import { build } from 'vite'
import { builtinModules } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function localVSCodeFixture(
  root: string,
  observeSettings = false,
) {
  const localUserDataDir = join(root, 'local user')
  const localExtensionsDir = join(root, 'local extensions')
  await mkdir(join(localUserDataDir, 'User'), { recursive: true })
  const terminalSettings =
    process.platform === 'win32'
      ? `
    "terminal.integrated.defaultProfile.windows": "Fixture PowerShell",
    "terminal.integrated.profiles.windows": { "Fixture PowerShell": {
      "path": ${JSON.stringify(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))},
      "args": ["-NoLogo", "-NoProfile"]
    } },`
      : ''
  await writeFile(
    join(localUserDataDir, 'User', 'settings.json'),
    `{
    // Local settings may contain comments and trailing commas.
    ${terminalSettings}
    "editor.fontSize": 23,
    "editor.accessibilitySupport": "on",
    "terminal.integrated.enablePersistentSessions": false,
    "terminal.integrated.persistentSessionReviveProcess": "never",
    "security.workspace.trust.enabled": true,
    "workbench.startupEditor": "none",
  }`,
  )
  await writeFile(
    join(localUserDataDir, 'User', 'keybindings.json'),
    '[{"key":"ctrl+alt+9","command":"ade.checkImport"}]',
  )
  const folder = 'ade.import-test-1.0.0'
  await mkdir(join(localExtensionsDir, folder), { recursive: true })
  await writeFile(
    join(localExtensionsDir, folder, 'package.json'),
    JSON.stringify({
      name: 'import-test',
      publisher: 'ade',
      version: '1.0.0',
      engines: { vscode: '^1.96.0' },
      main: './index.js',
      extensionKind: ['workspace'],
      activationEvents: ['onStartupFinished'],
      capabilities: { untrustedWorkspaces: { supported: true } },
      contributes: {
        commands: [
          {
            command: 'ade.checkImport',
            title: 'ADE: Check Imported Extension',
          },
          {
            command: 'ade.editSettings',
            title: 'ADE: Change Imported Settings',
          },
          ...[
            'codex',
            'claude',
            'ordinary',
            'hiddenIcons',
            'hiddenTabs',
            'close',
          ].map((kind) => ({
            command: `ade.pasteFixture.${kind}`,
            title: `ADE: Paste Fixture ${kind}`,
          })),
        ],
      },
    }),
  )
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
    build: {
      target: 'node22',
      outDir: join(localExtensionsDir, folder),
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(
          new URL(
            '../../extensions/ade-terminals/src/chats.ts',
            import.meta.url,
          ),
        ),
        formats: ['cjs'],
        fileName: () => 'chats.js',
      },
      rollupOptions: {
        external: [
          'vscode',
          /^node:/,
          ...builtinModules,
          'bufferutil',
          'utf-8-validate',
        ],
      },
    },
  })
  await writeFile(
    join(localExtensionsDir, folder, 'index.js'),
    `
    const vscode = require('vscode');
    exports.activate = context => {
      const pasteTerminals = [];
      const ids = new Map();
      const changes = new vscode.EventEmitter();
      const { ChatController } = require('./chats.js');
      context.subscriptions.push(changes, new ChatController({ id: terminal => ids.get(terminal), find: id => [...ids].find(entry => entry[1] === id)?.[0], onDidChange: changes.event }, operation => operation()));
      for (const [name, setting, value] of [['hiddenIcons', 'showIcons', false], ['hiddenTabs', 'showTabs', 'none']]) context.subscriptions.push(vscode.commands.registerCommand('ade.pasteFixture.' + name, () => vscode.workspace.getConfiguration('workbench.editor').update(setting, value, vscode.ConfigurationTarget.Global)));
      for (const provider of ['codex', 'claude', 'ordinary']) context.subscriptions.push(vscode.commands.registerCommand('ade.pasteFixture.' + provider, () => {
        const terminal = vscode.window.createTerminal({ name: 'ADE paste fixture ' + provider, location: vscode.TerminalLocation.Editor, iconPath: new vscode.ThemeIcon('terminal') });
        if (provider !== 'ordinary') ids.set(terminal, 'fixture-' + provider);
        pasteTerminals.push(terminal);
        terminal.show();
      }));
      context.subscriptions.push(vscode.commands.registerCommand('ade.pasteFixture.close', () => { for (const terminal of pasteTerminals) terminal.dispose(); }));
      if (${observeSettings}) {
        const fs = require('node:fs');
        const path = require('node:path');
        const target = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'settings-observations.jsonl');
        const record = () => fs.appendFileSync(target, JSON.stringify({ pid: process.pid,
          font: vscode.workspace.getConfiguration('editor').get('fontSize'),
          hotExit: vscode.workspace.getConfiguration('files').get('hotExit'),
          rulers: vscode.workspace.getConfiguration('editor').get('rulers'),
        }) + '\\n');
        record();
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(record));
      }
      context.subscriptions.push(vscode.commands.registerCommand('ade.checkImport', () => {
        const font = vscode.workspace.getConfiguration('editor').get('fontSize');
        vscode.window.showInformationMessage('ADE_IMPORTED_' + font + '_' + (process.versions.node ? 'NODE' : 'WEB') + '_' + (vscode.workspace.isTrusted ? 'TRUSTED' : 'RESTRICTED'));
      }));
      context.subscriptions.push(vscode.commands.registerCommand('ade.editSettings', () =>
        vscode.workspace.getConfiguration('editor').update('fontSize', 29, vscode.ConfigurationTarget.Global)));
    };
  `,
  )
  await writeFile(
    join(localExtensionsDir, 'extensions.json'),
    JSON.stringify([
      {
        identifier: { id: 'ade.import-test' },
        version: '1.0.0',
        relativeLocation: folder,
        location: {
          scheme: 'file',
          path: decodeURIComponent(
            pathToFileURL(join(localExtensionsDir, folder)).pathname,
          ),
        },
        metadata: { installedTimestamp: 1 },
      },
    ]),
  )
  return { localUserDataDir, localExtensionsDir }
}
