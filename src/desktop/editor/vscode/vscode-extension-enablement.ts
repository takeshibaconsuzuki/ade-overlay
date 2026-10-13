import type { ExtensionIdentifier } from '../../../shared/api'
import type { AdeWorkbenchGlobal } from '../../../shared/vscode-ade-handle'

// Serialized into the workbench. The hook runs after storage initialization and
// before workbench creation, so no extension can activate using stale enablement.
export function attachExtensionEnablement(
  readSnapshot: () => Promise<ExtensionIdentifier[]>,
  reportStartupFailure: () => void,
): void {
  const handle = (globalThis as unknown as AdeWorkbenchGlobal).adeHandle
  handle.initializeExtensions = async (storage) => {
    try {
      const disabled = await readSnapshot()
      // PROFILE = 0, MACHINE = 1. Workspace overrides are deliberately untouched.
      const key = 'extensionsIdentifiers/disabled'
      if (disabled.length) storage.store(key, JSON.stringify(disabled), 0, 1)
      else storage.remove(key, 0)
      await storage.flush()
      delete handle.initializeExtensions
    } catch (error) {
      reportStartupFailure()
      throw error
    }
  }
}
