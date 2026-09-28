/* eslint @typescript-eslint/no-require-imports: "off" -- VS Code loads extension tests as CommonJS. */
const assert = require('node:assert/strict')
const { access, readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const vscode = require('vscode')

async function eventually(read, label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}`)
}

const isTerminalTab = (tab) => tab.input instanceof vscode.TabInputTerminal
const terminalTabs = () =>
  vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter((tab) => tab.input instanceof vscode.TabInputTerminal),
  )

exports.run = async () => {
  const extension = vscode.extensions.getExtension('ade-overlay.ade-terminals')
  assert.ok(extension, 'development extension is discovered')
  await extension.activate()
  await vscode.commands.executeCommand('workbench.view.extension.adeTerminals')
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath

  // Starting with chat uses the sole empty group at full width.
  await vscode.commands.executeCommand('adeTerminals.codex')
  assert.equal(vscode.window.tabGroups.all.length, 1)
  const chat = vscode.window.tabGroups.activeTabGroup
  assert.equal(chat.tabs.length, 1)
  assert.ok(chat.tabs.every(isTerminalTab))
  assert.equal(vscode.window.tabGroups.activeTabGroup, chat)
  await eventually(
    () =>
      access(join(workspace, 'ade-codex.txt')).then(
        () => true,
        () => false,
      ),
    'Codex command runs in worktree',
  )
  assert.match(
    (await readFile(join(workspace, 'ade-codex.txt'), 'utf8')).replaceAll(
      '\0',
      '',
    ),
    /codex/,
  )

  // A normal open from the focused chat must honor the group lock.
  const file = vscode.Uri.file(join(workspace, 'example.txt'))
  await writeFile(file.fsPath, 'group routing test')
  await vscode.commands.executeCommand('vscode.open', file)
  await eventually(
    () =>
      vscode.window.activeTextEditor?.document.uri.toString() ===
      file.toString(),
    'file opens',
  )
  assert.notEqual(vscode.window.tabGroups.activeTabGroup, chat)
  assert.equal(
    vscode.window.tabGroups.all.length,
    2,
    'a file creates the second group only when needed',
  )
  assert.ok(!chat.tabs.some((tab) => tab.input instanceof vscode.TabInputText))

  await vscode.commands.executeCommand('adeTerminals.claude')
  assert.equal(vscode.window.tabGroups.activeTabGroup, chat)
  assert.equal(chat.tabs.length, 2)
  await eventually(
    () =>
      access(join(workspace, 'ade-claude.txt')).then(
        () => true,
        () => false,
      ),
    'Claude command runs in worktree',
  )
  await vscode.commands.executeCommand('adeTerminals.terminal')
  const normal = vscode.window.tabGroups.activeTabGroup
  assert.notEqual(normal, chat)
  assert.ok(normal.tabs.some(isTerminalTab))
  assert.equal(
    terminalTabs().length,
    vscode.window.terminals.length,
    'every terminal has an editor tab',
  )

  // Concurrent commands must not create multiple chat groups or misroute shells.
  await Promise.all(
    ['codex', 'terminal', 'claude'].map((kind) =>
      vscode.commands.executeCommand(`adeTerminals.${kind}`),
    ),
  )
  assert.equal(chat.tabs.length, 4)
  assert.ok(chat.tabs.every(isTerminalTab))
  assert.equal(normal.tabs.filter(isTerminalTab).length, 2)

  // Closing the ordinary group leaves chat at full width until ordinary content opens.
  await vscode.window.tabGroups.close(normal)
  await eventually(
    () => vscode.window.tabGroups.all.length === 1,
    'ordinary group closes',
  )
  await vscode.commands.executeCommand('adeTerminals.claude')
  assert.equal(vscode.window.tabGroups.all.length, 1)
  assert.equal(vscode.window.tabGroups.activeTabGroup, chat)
  await vscode.commands.executeCommand('adeTerminals.terminal')
  assert.equal(vscode.window.tabGroups.all.length, 2)
  const replacement = vscode.window.tabGroups.activeTabGroup
  assert.notEqual(replacement, chat)
  await vscode.commands.executeCommand('vscode.open', file)
  assert.equal(
    vscode.window.tabGroups.activeTabGroup,
    replacement,
    'normal terminal group stays unlocked for files',
  )

  await vscode.window.tabGroups.close(chat)
  await eventually(
    () => !vscode.window.tabGroups.all.includes(chat),
    'chat group closes',
  )
  await vscode.commands.executeCommand('adeTerminals.codex')
  assert.notEqual(vscode.window.tabGroups.activeTabGroup, replacement)
  assert.ok(vscode.window.tabGroups.activeTabGroup.tabs.every(isTerminalTab))

  // Column numbers change when groups move; tracked groups must follow them.
  const moved = vscode.window.tabGroups.activeTabGroup
  await vscode.commands.executeCommand(
    'workbench.action.moveActiveEditorGroupLeft',
  )
  await eventually(() => moved.viewColumn === 1, 'chat group moves left')
  await vscode.commands.executeCommand('adeTerminals.terminal')
  assert.equal(vscode.window.tabGroups.activeTabGroup, replacement)
  await vscode.commands.executeCommand('adeTerminals.claude')
  assert.equal(vscode.window.tabGroups.activeTabGroup, moved)

  // An empty layout starts with an ordinary shell; creating chat afterwards
  // must preserve that shell and keep the original group available for files.
  for (const terminal of vscode.window.terminals) terminal.dispose()
  await eventually(
    () => vscode.window.terminals.length === 0,
    'terminals close',
  )
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await vscode.commands.executeCommand('workbench.action.joinAllGroups')
  await eventually(
    () => vscode.window.tabGroups.all.length === 1,
    'layout resets',
  )
  await vscode.commands.executeCommand('adeTerminals.terminal')
  const first = vscode.window.tabGroups.activeTabGroup
  assert.equal(
    vscode.window.tabGroups.all.length,
    1,
    'ordinary shell starts at full width',
  )
  await vscode.commands.executeCommand('adeTerminals.codex')
  assert.notEqual(vscode.window.tabGroups.activeTabGroup, first)
  assert.ok(first.tabs.some(isTerminalTab))

  // If the sole chat group becomes empty, a normal terminal can reuse it.
  await vscode.window.tabGroups.close(first)
  const soleChat = vscode.window.tabGroups.all[0]
  await vscode.window.tabGroups.close([...soleChat.tabs])
  await eventually(
    () =>
      vscode.window.tabGroups.all.length === 1 &&
      vscode.window.tabGroups.all[0].tabs.length === 0,
    'sole chat group becomes empty',
  )
  await vscode.commands.executeCommand('adeTerminals.terminal')
  assert.equal(
    vscode.window.tabGroups.all.length,
    1,
    'empty chat group is reusable by normal terminals',
  )

  // Existing empty groups are reused even when the active group contains files or shells.
  const occupied = vscode.window.tabGroups.activeTabGroup
  await vscode.commands.executeCommand('workbench.action.newGroupRight')
  await eventually(
    () => vscode.window.tabGroups.all.length === 2,
    'empty split appears',
  )
  const empty = vscode.window.tabGroups.all.find((group) => group !== occupied)
  await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')
  await vscode.commands.executeCommand('adeTerminals.claude')
  assert.equal(vscode.window.tabGroups.activeTabGroup, empty)
  assert.equal(
    vscode.window.tabGroups.all.length,
    2,
    'reuse empty split instead of making a third group',
  )

  // Claude alone also fills the editor, and more chat terminals reuse that group.
  await vscode.window.tabGroups.close(occupied)
  await vscode.window.tabGroups.close([...empty.tabs])
  await eventually(
    () =>
      vscode.window.tabGroups.all.length === 1 &&
      vscode.window.tabGroups.all[0].tabs.length === 0,
    'empty layout returns',
  )
  await vscode.commands.executeCommand('adeTerminals.claude')
  await vscode.commands.executeCommand('adeTerminals.codex')
  assert.equal(vscode.window.tabGroups.all.length, 1)
  assert.equal(vscode.window.tabGroups.activeTabGroup.tabs.length, 2)

  // A new activation neither adopts nor destroys terminals from the old one.
  const {
    TerminalLauncher,
  } = require('../../extensions/ade-terminals/out/launcher.js')
  const previousChat = vscode.window.tabGroups.activeTabGroup
  const previousTerminals = [...vscode.window.terminals]
  const fresh = new TerminalLauncher()
  assert.equal(
    fresh.getSelectedTerminal(),
    undefined,
    'new activation does not adopt old groups for selection',
  )
  assert.equal(vscode.window.tabGroups.all.length, 1)
  assert.deepEqual([...vscode.window.terminals], previousTerminals)
  const newChatTerminal = await fresh.open('codex')
  const freshChat = vscode.window.tabGroups.activeTabGroup
  assert.notEqual(freshChat, previousChat)
  assert.equal(previousChat.tabs.length, 2)
  assert.equal(freshChat.tabs.length, 1)
  assert.ok(
    previousTerminals.every((item) => vscode.window.terminals.includes(item)),
  )
  assert.equal(newChatTerminal.creationOptions.name, undefined)
  assert.equal(newChatTerminal.creationOptions.isTransient, undefined)
  const secondChatTerminal = await fresh.open('claude')
  assert.equal(vscode.window.tabGroups.activeTabGroup, freshChat)
  assert.equal(freshChat.tabs.length, 2)
  // Native ordinary placement must avoid both old and current locked groups.
  await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')
  const newNormalTerminal = await fresh.open('terminal')
  const freshNormal = vscode.window.tabGroups.activeTabGroup
  assert.notEqual(freshNormal, previousChat)
  assert.notEqual(freshNormal, freshChat)
  assert.equal(newNormalTerminal.creationOptions.name, undefined)
  assert.equal(newNormalTerminal.creationOptions.isTransient, undefined)
  assert.equal(
    fresh.getSelectedTerminal(),
    secondChatTerminal,
    'another terminal group cannot clear selection',
  )
  await vscode.commands.executeCommand('vscode.open', file, {
    viewColumn: freshNormal.viewColumn,
    preview: false,
  })
  assert.equal(
    fresh.getSelectedTerminal(),
    secondChatTerminal,
    'a file in another group keeps selection',
  )
  await vscode.commands.executeCommand('vscode.open', file, {
    viewColumn: freshChat.viewColumn,
    preview: false,
  })
  await eventually(
    () => freshChat.activeTab?.input instanceof vscode.TabInputText,
    'file becomes current in chat group',
  )
  assert.equal(
    fresh.getSelectedTerminal(),
    undefined,
    'a file in the owned group clears selection',
  )
  newChatTerminal.show()
  await eventually(
    () => fresh.getSelectedTerminal() === newChatTerminal,
    'switching terminal tabs changes selection',
  )
  secondChatTerminal.show()
  await eventually(
    () => fresh.getSelectedTerminal() === secondChatTerminal,
    'second chat tab selected',
  )
  await vscode.window.tabGroups.close([freshChat, freshNormal])
  await eventually(
    () => vscode.window.tabGroups.all.length === 1,
    'fresh launcher groups close',
  )
  assert.equal(
    fresh.getSelectedTerminal(),
    undefined,
    'closing the owned group clears selection',
  )

  // VS Code uses focusLastEditorGroup for column nine, not focusNinthEditorGroup.
  while (vscode.window.tabGroups.all.length < 9) {
    const count = vscode.window.tabGroups.all.length
    await vscode.commands.executeCommand('workbench.action.newGroupRight')
    await eventually(
      () => vscode.window.tabGroups.all.length > count,
      'additional group appears',
    )
  }
  await vscode.commands.executeCommand('workbench.action.focusLastEditorGroup')
  await vscode.commands.executeCommand('adeTerminals.terminal')
  assert.equal(vscode.window.tabGroups.activeTabGroup.viewColumn, 9)
  assert.ok(vscode.window.tabGroups.activeTabGroup.tabs.some(isTerminalTab))

  // Exercise the actual bundled extension, reporter, OS process inspection and service.
  await vscode.workspace
    .getConfiguration('adeTerminals')
    .update(
      'codexCommand',
      process.env.ADE_CHAT_TEST_PROVIDER_COMMAND,
      vscode.ConfigurationTarget.Global,
    )
  await eventually(
    () =>
      vscode.workspace.getConfiguration('adeTerminals').get('codexCommand') ===
      process.env.ADE_CHAT_TEST_PROVIDER_COMMAND,
    'tracking command configured',
  )
  console.log('ADE live chats: launching provider')
  const tracked = await Promise.race([
    vscode.commands.executeCommand('adeTerminals.codex'),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Tracked launch timed out')), 20_000),
    ),
  ])
  console.log('ADE live chats: terminal created')
  assert.ok(tracked, 'tracked provider terminal is created')
  assert.equal(tracked.creationOptions.env.ADE_CHAT_EXTENSION_TOKEN, null)
  const snapshot = () =>
    fetch(process.env.ADE_CHAT_TEST_CONTROL).then((response) => response.json())
  const live = await eventually(
    async () =>
      (await snapshot()).chats.find(
        (chat) =>
          chat.terminalId === tracked.creationOptions.env.ADE_TERMINAL_ID,
      ),
    'real hook upserts idle chat',
  )
  assert.equal(live.activity, 'idle')
  assert.equal(live.provider, 'codex')
  assert.equal(live.terminalId, tracked.creationOptions.env.ADE_TERMINAL_ID)
  const other = await vscode.commands.executeCommand('adeTerminals.terminal')
  assert.equal(other.creationOptions.env.ADE_TERMINAL_ID, null)
  assert.equal(vscode.window.activeTerminal, other)
  await vscode.commands.executeCommand('adeTerminals.activateChat', live)
  await eventually(
    () => vscode.window.activeTerminal === tracked,
    'chat click focuses exact terminal',
  )
  // A new controller must take control from
  // the stale host and focus the existing terminal without changing its group.
  const {
    ChatController,
  } = require('../../extensions/ade-terminals/out/chats.js')
  const restored = new ChatController({
    workspaceState: { get: () => ({}), update: async () => {} },
  })
  try {
    await eventually(
      () => restored.getSnapshot().chats.length === 1,
      'new activation receives live chats',
    )
    assert.equal(
      restored.getActiveChatId(),
      undefined,
      'restored identities alone do not adopt layout selection',
    )
    restored.selectTerminal(tracked)
    await eventually(
      () => restored.getActiveChatId() === live.id,
      'restored local chat is selected',
    )
    other.show()
    await eventually(
      () => vscode.window.activeTerminal === other,
      'select other terminal',
    )
    assert.equal(
      restored.getActiveChatId(),
      live.id,
      'global terminal focus does not change group selection',
    )
    restored.selectTerminal(undefined)
    await eventually(
      () => restored.getActiveChatId() === undefined,
      'no terminal selected in the owned group',
    )
    restored.selectTerminal(tracked)
    await restored.activateChat(live)
    await eventually(
      () => vscode.window.activeTerminal === tracked,
      'restored activation focuses same terminal',
    )
    await eventually(
      () => restored.getActiveChatId() === live.id,
      'navigation updates local selection',
    )
  } finally {
    restored.dispose()
  }
  await writeFile(join(workspace, 'finish-provider'), '')
  await eventually(
    () => !vscode.window.terminals.includes(tracked),
    'provider exit closes its terminal',
  )
  await eventually(
    async () => (await snapshot()).chats.length === 0,
    'reconciliation drops terminated provider',
  )
  await fetch(new URL('/disconnect', process.env.ADE_CHAT_TEST_CONTROL), {
    method: 'POST',
  })
  let timer
  const [failedProvider, disconnectedShell] = await Promise.race([
    Promise.all([
      vscode.commands.executeCommand('adeTerminals.claude'),
      vscode.commands.executeCommand('adeTerminals.terminal'),
    ]),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Disconnected launches were blocked')),
        5000,
      )
    }),
  ]).finally(() => clearTimeout(timer))
  assert.ok(
    disconnectedShell,
    'ordinary launch also completes while tracking is disconnected',
  )
  assert.ok(failedProvider, 'provider command launches before testing its exit')
  await writeFile(join(workspace, 'finish-claude'), '')
  await eventually(
    () => !vscode.window.terminals.includes(failedProvider),
    'failed provider command also closes terminal',
  )
  assert.ok(
    vscode.window.terminals.includes(other),
    'ordinary terminal remains open',
  )
  console.log(
    'ADE extension: provider commands, editor routing, locks, activation isolation, live hook reporting, exact chat focus and reconciled removal passed.',
  )
  for (const terminal of vscode.window.terminals) terminal.dispose()
  fresh.dispose()
}
