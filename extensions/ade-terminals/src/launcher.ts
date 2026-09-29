import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { providerShellCommand } from './provider-command.js'
import {
  chatCommandsSchema,
  defaultChatCommands,
} from '../../../src/shared/chat-commands.ts'

import type { LaunchKind, LaunchProvider } from '../../../src/shared/sidebar.ts'

const groupOrdinals = [
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
  'Sixth',
  'Seventh',
  'Eighth',
  'Last',
]

async function waitFor<T>(
  read: () => T | undefined,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 10_000
  do {
    const result = read()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}. Please try again.`)
}

export class TerminalLauncher implements vscode.Disposable {
  private readonly selectionChanges = new vscode.EventEmitter<
    vscode.Terminal | undefined
  >()
  readonly onDidChangeSelection = this.selectionChanges.event
  private readonly tabs = new Map<vscode.Tab, vscode.Terminal>()
  private selectedTerminal?: vscode.Terminal
  private readonly subscriptions: vscode.Disposable[]
  constructor(
    private readonly registerTerminal: (
      terminal: vscode.Terminal,
      terminalId: string,
      provider: LaunchProvider,
    ) => void,
  ) {
    this.subscriptions = [
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        for (const tab of event.closed) this.tabs.delete(tab)
        this.updateSelection()
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() =>
        this.updateSelection(),
      ),
      vscode.window.onDidCloseTerminal(() => this.updateSelection()),
    ]
  }
  private queue: Promise<unknown> = Promise.resolve()
  private chatGroup?: vscode.TabGroup

  getSelectedTerminal(): vscode.Terminal | undefined {
    const tab = this.chatGroup?.activeTab
    const terminal = tab && this.tabs.get(tab)
    return this.chatGroup &&
      vscode.window.tabGroups.all.includes(this.chatGroup) &&
      terminal &&
      vscode.window.terminals.includes(terminal)
      ? terminal
      : undefined
  }

  private updateSelection(): void {
    const terminal = this.getSelectedTerminal()
    if (terminal !== this.selectedTerminal) {
      this.selectedTerminal = terminal
      this.selectionChanges.fire(terminal)
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose()
    this.selectionChanges.dispose()
    this.tabs.clear()
  }

  open(kind: LaunchKind): Promise<vscode.Terminal> {
    return this.run(() => this.launch(kind))
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    // Group creation/focus commands are global workbench operations.
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async focus(group: vscode.TabGroup): Promise<void> {
    const ordinal = groupOrdinals[group.viewColumn - 1]
    if (
      !ordinal ||
      !vscode.window.tabGroups.all.includes(group) ||
      (group.viewColumn === 9 && vscode.window.tabGroups.all.length !== 9)
    ) {
      throw new Error('The terminal editor group is no longer available.')
    }
    await vscode.commands.executeCommand(
      `workbench.action.focus${ordinal}EditorGroup`,
    )
    await waitFor(
      () =>
        vscode.window.tabGroups.activeTabGroup === group ? true : undefined,
      'the editor group to become active',
    )
  }

  private async newGroup(): Promise<vscode.TabGroup> {
    const before = new Set(vscode.window.tabGroups.all)
    if (before.size >= groupOrdinals.length) {
      throw new Error(
        'Close an editor group before creating another terminal group.',
      )
    }
    await vscode.commands.executeCommand('workbench.action.newGroupRight')
    return waitFor(
      () => vscode.window.tabGroups.all.find((group) => !before.has(group)),
      'a new editor group',
    )
  }

  private async targetGroup(): Promise<vscode.TabGroup> {
    const groups = vscode.window.tabGroups.all
    const active = vscode.window.tabGroups.activeTabGroup
    this.chatGroup ??=
      active.tabs.length === 0
        ? active
        : groups.find((group) => group.tabs.length === 0)
    this.chatGroup ??= await this.newGroup()
    // A single chat group can be locked. VS Code creates another group when
    // a file is opened, so there is no need to reserve an empty ordinary group.
    await this.focus(this.chatGroup)
    await vscode.commands.executeCommand('workbench.action.lockEditorGroup')
    return this.chatGroup
  }

  private async launch(kind: LaunchKind): Promise<vscode.Terminal> {
    const folders = vscode.workspace.workspaceFolders
    if (folders?.length !== 1)
      throw new Error('ADE terminals require exactly one workspace folder.')
    const folder = folders[0]

    const chat = kind !== 'terminal'
    const command = chat
      ? {
          ...defaultChatCommands,
          ...chatCommandsSchema.parse(
            JSON.parse(process.env.ADE_CHAT_COMMANDS ?? '{}'),
          ),
        }[kind]
      : undefined

    // Ownership lasts only for this launcher activation and ends when the group
    // is removed or emptied. Placement is independent of saved chat identities.
    if (
      this.chatGroup &&
      (!vscode.window.tabGroups.all.includes(this.chatGroup) ||
        this.chatGroup.tabs.length === 0)
    )
      this.chatGroup = undefined
    const group = chat ? await this.targetGroup() : undefined
    if (!chat && vscode.window.tabGroups.activeTabGroup.tabs.length === 0) {
      // An empty, formerly locked chat group is available for ordinary content.
      await vscode.commands.executeCommand('workbench.action.unlockEditorGroup')
    }
    const previousTabs = new Set(
      vscode.window.tabGroups.all.flatMap((item) => item.tabs),
    )
    const terminalId = chat ? randomUUID() : undefined
    const terminal = vscode.window.createTerminal({
      env: {
        ADE_CHAT_EXTENSION_TOKEN: null,
        ADE_TERMINAL_ID: terminalId ?? null,
      },
      cwd: folder.uri,
      ...(chat ? { waitOnExit: false } : {}),
      // Let VS Code route ordinary terminals around locked groups, including
      // groups left behind by earlier activations that we no longer manage.
      location: group
        ? { viewColumn: group.viewColumn }
        : vscode.TerminalLocation.Editor,
      iconPath: new vscode.ThemeIcon(chat ? 'comment-discussion' : 'terminal'),
    })
    if (terminalId && kind !== 'terminal')
      this.registerTerminal(terminal, terminalId, kind)
    try {
      terminal.show()
      const tab = await waitFor(
        () =>
          (
            group?.tabs ??
            vscode.window.tabGroups.all.flatMap((item) => item.tabs)
          ).find(
            (tab) =>
              tab.input instanceof vscode.TabInputTerminal &&
              !previousTabs.has(tab),
          ),
        'the terminal editor',
      )
      if (chat) {
        this.tabs.set(tab, terminal)
        this.updateSelection()
      }
      await this.focus(tab.group)
      // VS Code can auto-lock the first terminal tab in an empty group when
      // another group exists. Ordinary shells leave their group open for files.
      await vscode.commands.executeCommand(
        chat
          ? 'workbench.action.lockEditorGroup'
          : 'workbench.action.unlockEditorGroup',
      )
      if (command)
        terminal.sendText(
          providerShellCommand(
            command,
            terminal.state.shell ?? vscode.env.shell,
          ),
          true,
        )
      return terminal
    } catch (error) {
      terminal.dispose()
      throw error
    }
  }
}
