import * as vscode from 'vscode'

export type TerminalKind = 'terminal' | 'codex' | 'claude'

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

export class TerminalLauncher {
  private queue: Promise<unknown> = Promise.resolve()
  private chatGroup?: vscode.TabGroup

  open(kind: TerminalKind): Promise<vscode.Terminal | undefined> {
    // Group creation/focus commands are global workbench operations.
    const operation = this.queue.then(() => this.launch(kind))
    this.queue = operation.catch(() => undefined)
    return operation
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

  private async launch(
    kind: TerminalKind,
  ): Promise<vscode.Terminal | undefined> {
    const folders = vscode.workspace.workspaceFolders
    const folder =
      folders && folders.length > 1
        ? await vscode.window.showWorkspaceFolderPick({
            placeHolder: 'Choose the terminal workspace',
          })
        : folders?.[0]
    if (folders && folders.length > 1 && !folder) return undefined

    const chat = kind !== 'terminal'
    const command = chat
      ? vscode.workspace
          .getConfiguration('adeTerminals')
          .get<string>(`${kind}Command`, kind)
          .trim()
      : undefined
    if (chat && !command)
      throw new Error(
        `Configure adeTerminals.${kind}Command before launching it.`,
      )

    // Ownership lasts only for this launcher activation and ends when the group
    // is removed or emptied. Terminal objects and persisted metadata are unneeded.
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
    const terminal = vscode.window.createTerminal({
      cwd: folder?.uri,
      // Let VS Code route ordinary terminals around locked groups, including
      // groups left behind by earlier activations that we no longer manage.
      location: group
        ? { viewColumn: group.viewColumn }
        : vscode.TerminalLocation.Editor,
      iconPath: new vscode.ThemeIcon(chat ? 'comment-discussion' : 'terminal'),
    })
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
      await this.focus(tab.group)
      // VS Code can auto-lock the first terminal tab in an empty group when
      // another group exists. Ordinary shells leave their group open for files.
      await vscode.commands.executeCommand(
        chat
          ? 'workbench.action.lockEditorGroup'
          : 'workbench.action.unlockEditorGroup',
      )
      if (command) terminal.sendText(command, true)
      return terminal
    } catch (error) {
      terminal.dispose()
      throw error
    }
  }
}
