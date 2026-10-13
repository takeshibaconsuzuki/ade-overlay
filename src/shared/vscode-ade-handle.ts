// References remain in the workbench's JavaScript context; they cannot cross Electron IPC.
export interface AdeHandle {
  // False until startup has installed the service lookup. Remains false if initialization fails.
  workbenchReady: boolean
  // Resolves a service or contribution. Throws before the workbench is ready or for unknown IDs.
  get(id: string): unknown
  // Installed by the preload and awaited before workbench creation, then removed.
  initializeExtensions?(storage: {
    store(key: string, value: string, scope: 0, target: 1): void
    remove(key: string, scope: 0): void
    flush(): Promise<void>
  }): Promise<void>
  // The preload attaches notifications; the page adapter installs application behavior on first use.
  vscodeSettings?: {
    changed(generation: number, content: string): void
    apply?(content: string, generation: number): Promise<void>
  }
}

export interface AdeWorkbenchGlobal {
  // Installed by the preload.
  adeHandle: AdeHandle
}

// Serialized into the page by the preload; keep runtime code self-contained.
export function installAdeHandle(): void {
  const handle: AdeHandle = {
    workbenchReady: false,
    get() {
      throw new Error('VS Code workbench is not ready')
    },
  }
  const scope = globalThis as unknown as AdeWorkbenchGlobal
  scope.adeHandle = handle
}
