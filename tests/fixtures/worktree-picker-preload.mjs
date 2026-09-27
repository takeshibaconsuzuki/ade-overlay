import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('companion', {
  getStatus: () =>
    Promise.resolve({ state: 'connected', url: 'ws://test.invalid/companion' }),
  listWorktrees: () => ipcRenderer.invoke('test:list'),
  openEditor: (input) => ipcRenderer.invoke('test:open', input),
  createWorktree: (input) => ipcRenderer.invoke('test:create', input),
  deleteWorktree: (input) => ipcRenderer.invoke('test:delete', input),
  setWorktreeError: (input) => ipcRenderer.invoke('test:error', input),
  onStatus: () => () => {},
  onWorktreesUpdated: (callback) => {
    const listener = (_event, update) => callback(update)
    ipcRenderer.on('test:update', listener)
    return () => ipcRenderer.removeListener('test:update', listener)
  },
})
