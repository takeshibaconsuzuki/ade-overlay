import { contextBridge, ipcRenderer } from 'electron'
import { attachExtensionEnablement } from './vscode-extension-enablement'
import {
  installAdeHandle,
  type AdeHandle,
  type AdeWorkbenchGlobal,
} from '../../../shared/vscode-ade-handle'

contextBridge.executeInMainWorld({ func: installAdeHandle })
contextBridge.executeInMainWorld({
  func: attachExtensionEnablement,
  args: [
    () => ipcRenderer.invoke('ade:disabled-extensions'),
    () => ipcRenderer.send('ade:startup-failed'),
  ],
})

// Callbacks cross context isolation; the handle and VS Code services stay in the page.
contextBridge.executeInMainWorld({
  func: (changed: NonNullable<AdeHandle['vscodeSettings']>['changed']) => {
    const scope = globalThis as unknown as AdeWorkbenchGlobal
    scope.adeHandle.vscodeSettings = { changed }
  },
  args: [
    (generation: number, content: string) => {
      ipcRenderer.send('ade:settings-changed', generation, content)
    },
  ],
})
