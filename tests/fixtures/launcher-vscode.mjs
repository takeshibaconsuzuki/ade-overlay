export { EventEmitter } from './chat-vscode.mjs'
export class ThemeIcon {
  constructor(id) {
    this.id = id
  }
}
export class TabInputTerminal {}
export const TerminalLocation = { Editor: 1 }
const disposable = () => ({ dispose() {} })
export const effects = []
const group = { viewColumn: 1, tabs: [] }
export const workspace = {
  workspaceFolders: undefined,
}
export const env = { shell: 'bash' }
export const commands = {
  executeCommand: async (command) => {
    effects.push(command)
  },
}
export const window = {
  tabGroups: {
    all: [group],
    activeTabGroup: group,
    onDidChangeTabs: disposable,
    onDidChangeTabGroups: disposable,
  },
  terminals: [],
  onDidCloseTerminal: disposable,
  createTerminal(options) {
    effects.push('createTerminal')
    const terminal = {
      creationOptions: options,
      state: {},
      show() {},
      sentText: [],
      sendText(text) {
        this.sentText.push(text)
      },
      dispose() {},
    }
    group.tabs.push({ input: new TabInputTerminal(), group })
    group.activeTab = group.tabs.at(-1)
    this.terminals.push(terminal)
    return terminal
  },
}
