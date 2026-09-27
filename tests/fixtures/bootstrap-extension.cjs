/* eslint-disable @typescript-eslint/no-require-imports -- VS Code loads this fixture as a CommonJS extension. */
const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WebSocket } = require(require('./bootstrap-config.json').ws)

exports.activate = async (context) => {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath
  try {
    const token = process.env.ADE_CHAT_EXTENSION_TOKEN
    delete process.env.ADE_CHAT_EXTENSION_TOKEN
    if (!token) throw new Error('Extension host did not receive its credential')
    const activation = randomUUID()
    const url = new URL('/extension', process.env.ADE_CHAT_ENDPOINT)
    url.protocol = 'ws:'
    url.searchParams.set('activation', activation)
    url.searchParams.set('startedAt', Date.now().toString())
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    context.subscriptions.push({ dispose: () => socket.terminate() })
    await new Promise((resolve, reject) => {
      socket.on('error', reject)
      socket.on('open', () =>
        socket.send(
          JSON.stringify({ type: 'inventory', id: 'ready', terminals: [] }),
        ),
      )
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString())
        if (message.type === 'result' && message.id === 'ready') resolve()
      })
    })
    const probe = path.join(root, 'environment-probe.cjs')
    fs.writeFileSync(
      probe,
      `require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ control: Object.keys(process.env).some(key => key.toUpperCase() === 'ADE_CHAT_EXTENSION_TOKEN'), activity: !!process.env.ADE_CHAT_ACTIVITY_TOKEN }));`,
    )
    await vscode.commands.executeCommand('workbench.action.terminal.new')
    const terminal = vscode.window.activeTerminal
    if (!terminal) throw new Error('Native terminal was not created')
    const quote = (text) =>
      "'" +
      text.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") +
      "'"
    terminal.sendText(
      (process.platform === 'win32' ? '& ' : '') +
        [process.execPath, probe, path.join(root, 'native-environment.json')]
          .map(quote)
          .join(' '),
    )
    const task = new vscode.Task(
      { type: 'ade-test' },
      vscode.TaskScope.Workspace,
      'Environment probe',
      'ADE test',
      new vscode.ProcessExecution(process.execPath, [
        probe,
        path.join(root, 'task-environment.json'),
      ]),
    )
    await vscode.tasks.executeTask(task)
    fs.writeFileSync(
      path.join(root, 'bootstrap-extension.json'),
      JSON.stringify({ activation, pid: process.pid }),
    )
  } catch (error) {
    fs.writeFileSync(
      path.join(root, 'bootstrap-error.txt'),
      String(error.stack || error),
    )
  }
}
