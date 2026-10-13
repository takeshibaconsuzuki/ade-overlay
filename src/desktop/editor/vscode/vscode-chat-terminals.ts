import type { ChatTerminalLaunch } from '../../../shared/api'
import type { AdeWorkbenchGlobal } from '../../../shared/vscode-ade-handle'

// Internal contracts of the pinned workbench. VS Code owns these objects.
// eslint-disable-next-line @typescript-eslint/no-namespace -- Type-only workbench contracts.
declare namespace ChatTerminalServices {
  interface Disposable {
    dispose(): void
  }
  interface Group {
    id: number
    count: number
    lock(locked: boolean): void
    focus(): void
  }
  interface Groups {
    whenReady: Promise<void>
    activeGroup: Group
    getGroup(id: number): Group | undefined
    addGroup(reference: Group, direction: number): Group
    removeGroup(group: Group): void
    onDidActivateGroup(listener: () => void): Disposable
    onDidRemoveGroup(listener: (group: Group) => void): Disposable
  }
  interface Storage {
    getNumber(key: string, scope: 1): number | undefined
    store(key: string, value: number, scope: 1, target: 1): void
    remove(key: string, scope: 1): void
  }
  interface Terminal {
    resource: unknown
    isDisposed: boolean
    xtermReadyPromise: Promise<unknown>
    focus(): void
    dispose(): void
  }
  interface Terminals {
    createTerminal(options: {
      config: {
        executable: string
        args: string[]
        cwd: string
        env: Record<string, string>
        waitOnExit: false
      }
      location: number
    }): Promise<Terminal>
    setActiveInstance(terminal: Terminal): void
  }
  interface TerminalGroups {
    getGroupForInstance(
      terminal: Terminal,
    ): { removeInstance(terminal: Terminal): void } | undefined
  }
  interface TerminalEditors {
    resolveResource(terminal: Terminal): unknown
  }
  interface Editors {
    openEditor(
      input: {
        resource: unknown
        options: { pinned: boolean; preserveFocus: boolean; activation: number }
      },
      groupId: number,
    ): Promise<unknown>
  }
}

// Serialized into the workbench: keep runtime code self-contained.
export async function initializeChatTerminals(): Promise<void> {
  const scope = globalThis as unknown as AdeWorkbenchGlobal
  const deadline = Date.now() + 20_000
  while (!scope.adeHandle?.workbenchReady) {
    if (Date.now() >= deadline)
      throw new Error('VS Code chat terminal services did not become ready')
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  const handle = scope.adeHandle
  const groups = handle.get(
    'editorGroupsService',
  ) as ChatTerminalServices.Groups
  await groups.whenReady
  if (handle.chatTerminals) return
  const storage = handle.get('storageService') as ChatTerminalServices.Storage
  const groupKey = 'ade.chatTerminalGroup'
  const savedGroup = storage.getNumber(groupKey, 1) // StorageScope.WORKSPACE
  let group = savedGroup === undefined ? undefined : groups.getGroup(savedGroup)
  if (!group) storage.remove(groupKey, 1)
  groups.onDidRemoveGroup((removed) => {
    if (removed === group) {
      group = undefined
      storage.remove(groupKey, 1)
    }
  })
  let latestRequest = 0
  handle.chatTerminals = {
    async open(launch) {
      const terminals = handle.get(
        'terminalService',
      ) as ChatTerminalServices.Terminals
      const terminalGroups = handle.get(
        'terminalGroupService',
      ) as ChatTerminalServices.TerminalGroups
      const terminalEditors = handle.get(
        'terminalEditorService',
      ) as ChatTerminalServices.TerminalEditors
      const editors = handle.get(
        'editorService',
      ) as ChatTerminalServices.Editors

      const request = ++latestRequest
      let focusChanged = false
      const relinquishFocus = () => {
        focusChanged = true
      }
      const initialElement = document.activeElement
      const focus = groups.onDidActivateGroup(relinquishFocus)
      document.addEventListener('pointerdown', relinquishFocus, true)
      document.addEventListener('keydown', relinquishFocus, true)
      window.addEventListener('blur', relinquishFocus)
      let terminal: ChatTerminalServices.Terminal | undefined
      let target: ChatTerminalServices.Group | undefined
      try {
        // Creating in the panel does not show it. Move the resulting instance by
        // stable group ID, avoiding the focus and column races of the extension API.
        terminal = await terminals.createTerminal({
          config: {
            executable: launch.shellPath,
            args: launch.shellArgs,
            cwd: launch.worktreePath,
            env: { ADE_TERMINAL_ID: launch.terminalId },
            waitOnExit: false,
          },
          location: 1, // TerminalLocation.Panel
        })
        if (terminal.isDisposed) return
        group ??= groups.addGroup(groups.activeGroup, 3) // GroupDirection.RIGHT
        target = group
        target.lock(true)
        storage.store(groupKey, target.id, 1, 1) // Workspace-local, machine-specific state.
        terminalGroups.getGroupForInstance(terminal)?.removeInstance(terminal)
        await editors.openEditor(
          {
            resource: terminalEditors.resolveResource(terminal),
            options: { pinned: true, preserveFocus: true, activation: 3 }, // EditorActivation.PRESERVE
          },
          target.id,
        )
        await terminal.xtermReadyPromise
        if (terminal.isDisposed) return
        if (groups.getGroup(target.id) !== target) {
          terminal.dispose()
          return
        }
        // A later click, keystroke, or focus change takes precedence over launch focus.
        if (
          !focusChanged &&
          document.activeElement === initialElement &&
          request === latestRequest
        ) {
          terminals.setActiveInstance(terminal)
          target.focus()
          terminal.focus()
        }
      } catch (error) {
        terminal?.dispose()
        if (target?.count === 0 && groups.getGroup(target.id) === target)
          groups.removeGroup(target)
        throw error
      } finally {
        focus.dispose()
        document.removeEventListener('pointerdown', relinquishFocus, true)
        document.removeEventListener('keydown', relinquishFocus, true)
        window.removeEventListener('blur', relinquishFocus)
      }
    },
  }
}

// Serialized into the workbench: startup owns controller initialization.
export async function openChatTerminal(
  options: ChatTerminalLaunch,
): Promise<void> {
  const handle = (globalThis as unknown as AdeWorkbenchGlobal).adeHandle
  if (!handle.chatTerminals) throw new Error('Chat terminals are not ready')
  await handle.chatTerminals.open(options)
}
