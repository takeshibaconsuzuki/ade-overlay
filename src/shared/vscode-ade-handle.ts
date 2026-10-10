// References remain in the workbench's JavaScript context; they cannot cross Electron IPC.
export interface AdeHandle {
  // Resolves a service in the workbench container, or a named contribution. Unknown IDs throw.
  get(id: string): unknown
}

export interface AdeWorkbenchGlobal {
  // Installed during workbench initialization. Repeated calls return the same page-local handle.
  getAdeHandle(): AdeHandle
}
