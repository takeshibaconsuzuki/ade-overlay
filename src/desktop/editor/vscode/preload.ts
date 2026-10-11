import { contextBridge, ipcRenderer } from 'electron'
import type {
  AdeHandle,
  AdeWorkbenchGlobal,
} from '../../../shared/vscode-ade-handle'

// Attach the narrow notification callback to the workbench's handle without creating another global. The callback is proxied across context isolation; services remain in the workbench.
void contextBridge
  .executeInMainWorld({
    func: async (
      changed: NonNullable<AdeHandle['vscodeSettings']>['changed'],
    ) => {
      const scope = globalThis as unknown as AdeWorkbenchGlobal
      const deadline = Date.now() + 20_000
      while (typeof scope.getAdeHandle !== 'function') {
        if (Date.now() >= deadline)
          throw new Error('VS Code handle did not become ready')
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
      }
      scope.getAdeHandle().vscodeSettings = { changed }
    },
    args: [
      (generation: number, content: string) => {
        ipcRenderer.send('ade:settings-changed', generation, content)
      },
    ],
  })
  .catch((error: unknown) =>
    console.error('Unable to attach ADE settings notifications', error),
  )
