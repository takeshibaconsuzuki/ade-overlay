import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('pickerWindow', {
  hide: () => ipcRenderer.invoke('test:hide'),
  onHidden: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('test:hidden', listener)
    return () => ipcRenderer.removeListener('test:hidden', listener)
  },
})

contextBridge.exposeInMainWorld('companion', {
  getState: () => ipcRenderer.invoke('test:state'),
  openEditor: (input) => ipcRenderer.invoke('test:open', input),
  createWorktree: (input) => ipcRenderer.invoke('test:create', input),
  deleteWorktree: (input) => ipcRenderer.invoke('test:delete', input),
  setWorktreeError: (input) => ipcRenderer.invoke('test:error', input),
  onState: (callback) => {
    const listener = (_event, update) => callback(update)
    ipcRenderer.on('test:update', listener)
    return () => ipcRenderer.removeListener('test:update', listener)
  },
})
