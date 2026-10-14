import type { ChatTerminalLaunch } from '../shared/api'
import type { WorkbenchServices } from './services'

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
    onDidCloseEditor(listener: (event: { groupId: number }) => void): Disposable
    openEditor(
      input: {
        resource: unknown
        options: { pinned: boolean; preserveFocus: boolean; activation: number }
      },
      groupId: number,
    ): Promise<unknown>
  }
}

export async function createChatTerminals(handle: WorkbenchServices): Promise<{
  open(launch: ChatTerminalLaunch): Promise<void>
}> {
  const groups = handle.get(
    'editorGroupsService',
  ) as ChatTerminalServices.Groups
  await groups.whenReady
  const storage = handle.get('storageService') as ChatTerminalServices.Storage
  const editors = handle.get('editorService') as ChatTerminalServices.Editors
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
  const releaseEmptyGroup = () => {
    if (group?.count !== 0) return
    const empty = group
    group = undefined
    storage.remove(groupKey, 1)
    // VS Code retains its final editor group even after its last editor closes.
    empty.lock(false)
  }
  editors.onDidCloseEditor(({ groupId }) => {
    if (group?.id === groupId) releaseEmptyGroup()
  })
  let latestRequest = 0
  return {
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
        group ??=
          groups.activeGroup.count === 0
            ? groups.activeGroup
            : groups.addGroup(groups.activeGroup, 3) // GroupDirection.RIGHT
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
        if (target?.count === 0 && groups.getGroup(target.id) === target) {
          if (group === target) releaseEmptyGroup()
          groups.removeGroup(target)
        }
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
