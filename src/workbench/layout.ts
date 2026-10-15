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
  }
}
