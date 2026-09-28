/* eslint-disable @typescript-eslint/no-require-imports -- VS Code loads this fixture as a CommonJS extension. */
const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { ChatController } = require('./chats.cjs')

exports.activate = (context) => {
  void run(context)
}

async function run(context) {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath
  try {
    const controller = new ChatController(context)
    context.subscriptions.push(controller)
    const activation = controller.activation
    const until = async (check) => {
      const deadline = Date.now() + 15000
      while (!check()) {
        if (Date.now() >= deadline)
          throw new Error('Terminal restoration or connection timed out')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    await until(() => controller.getSnapshot().revision >= 0)
    const identityFile = path.join(root, 'terminal-identity.json')
    if (fs.existsSync(identityFile)) {
      const expected = JSON.parse(fs.readFileSync(identityFile, 'utf8'))
      await controller.focus(expected.terminalId, controller.focusGeneration)
      const restored = vscode.window.activeTerminal
      if ((await restored.processId) !== expected.pid)
        throw new Error('Restored terminal changed shell PID')
      fs.writeFileSync(
        path.join(root, 'restored-terminal.json'),
        JSON.stringify({
          terminalId: expected.terminalId,
          pid: await restored.processId,
        }),
      )
    } else {
      const terminalId = randomUUID()
      const terminal = vscode.window.createTerminal({
        env: { ADE_TERMINAL_ID: terminalId },
        location: vscode.TerminalLocation.Editor,
      })
      terminal.show()
      const pid = await terminal.processId
      await until(
        () =>
          context.workspaceState.get('adeChatTerminals', {})[pid]
            ?.terminalId === terminalId,
      )
      fs.writeFileSync(identityFile, JSON.stringify({ terminalId, pid }))
    }
    const reloadFile = path.join(root, 'reload-request')
    const watcher = fs.watch(root, () => {
      if (fs.existsSync(reloadFile)) {
        fs.unlinkSync(reloadFile)
        void vscode.commands.executeCommand('workbench.action.reloadWindow')
      }
    })
    context.subscriptions.push({ dispose: () => watcher.close() })
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
