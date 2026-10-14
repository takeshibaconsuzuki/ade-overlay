// Private contracts of the pinned VS Code distribution. References stay in the workbench.
export interface WorkbenchServices {
  get(id: string): unknown
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>
  registerCommand(
    id: string,
    handler: (...args: unknown[]) => unknown,
  ): { dispose(): void }
}

export interface ProfileStorage {
  store(key: string, value: string, scope: 0, target: 1): void
  remove(key: string, scope: 0): void
  flush(): Promise<void>
}
