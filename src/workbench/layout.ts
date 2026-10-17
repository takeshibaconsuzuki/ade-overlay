interface WorkbenchOptions {
  defaultLayout?: { views?: { id: string }[] }
  configurationDefaults?: Record<string, unknown>
}

// Configure before services initialize; VS Code restores saved layouts after the first opening.
export function configureWorkbench(options: WorkbenchOptions): void {
  options.defaultLayout = { views: [{ id: 'ade.sidebar' }] }
  options.configurationDefaults = {
    ...options.configurationDefaults,
    'workbench.sideBar.location': 'left',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    // Page Up and Page Down reach the shell on every platform (macOS binds them to viewport
    // paging otherwise); Shift+Page Up/Down still pages the viewport, handled by xterm.
    'terminal.integrated.commandsToSkipShell': [
      '-workbench.action.terminal.scrollUpPage',
      '-workbench.action.terminal.scrollDownPage',
    ],
  }
}
